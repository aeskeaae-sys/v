import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import {
  WEBHOOK_DOMAINS,
  type ApiKeyScope,
  type HealthReport,
  type InboxMode,
  type IngestEmailPayload,
  type MessageFolder,
  type TtlPreset,
} from './shared/types.ts';
import {
  createAdminAuthMiddleware,
  createApiAuthMiddleware,
  createCorsMiddleware,
  createOriginGuard,
  extractAdminToken,
  isAdminTokenValid,
  issueAuthSession,
  requireScope,
  revokeAuthSession,
} from './server/auth.ts';
import { validateProductionEnv } from './server/env.ts';
import { signWebhookPayload, verifyWebhookSignature } from './server/crypto.ts';
import { checkDomainMxRecords } from './server/dns.ts';
import {
  MailTmRateLimitError,
  fetchLiveMxDomains,
  provisionLiveMxAccount,
} from './server/mailtm.ts';
import { validateOutboundWebhookTarget } from './server/parser.ts';
import {
  getOutboundSmtpConfig,
  startSmtpBridge,
  testSmtpConnection,
} from './server/smtp.ts';
import { FlowMailStore, isWebhookDomain } from './server/store.ts';

export interface ServerInstanceOptions {
  dbPath?: string | null;
  legacyJsonPath?: string | null;
  smtpPort?: number;
  skipStarterInbox?: boolean;
  skipVite?: boolean;
}

export function createAppInstance(options: ServerInstanceOptions = {}) {
  const startedAt = Date.now();
  const store = new FlowMailStore(
    'dbPath' in options || 'legacyJsonPath' in options
      ? { filePath: options.dbPath ?? null, legacyJsonPath: options.legacyJsonPath }
      : undefined,
  );
  const smtpBridge = startSmtpBridge(store, options.smtpPort);

  let requireApiKeyForExternal =
    store.getRequireApiKeySetting() ??
    (process.env.REQUIRE_API_KEY === 'true');

  const authenticateApiRequest = createApiAuthMiddleware(store, () => requireApiKeyForExternal);

  async function deliverSingleWebhook(params: {
    webhookId: string | null;
    inboxId: string;
    inboxAddress: string;
    targetUrl: string;
    secret: string | null;
    eventId: string;
    eventType: string;
    payloadObj: unknown;
    maxAttempts?: number;
  }): Promise<{
    ok: boolean;
    httpStatus: number | null;
    latencyMs: number;
    eventId: string;
    error: string | null;
  }> {
    const check = await validateOutboundWebhookTarget(params.targetUrl);
    if (!check.ok) {
      return {
        ok: false,
        httpStatus: null,
        latencyMs: 0,
        eventId: params.eventId,
        error: check.error,
      };
    }

    const rawBody = JSON.stringify(params.payloadObj);
    const maxAttempts = params.maxAttempts ?? 3;
    const startedAtMs = Date.now();
    let lastStatus: number | null = null;
    let lastErr: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tsSec = Math.floor(Date.now() / 1000);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-FlowMail-Event': params.eventType,
        'X-RelayBox-Event': params.eventType,
        'X-RelayBox-Event-Id': params.eventId,
        'X-FlowMail-Inbox': params.inboxAddress,
      };
      if (params.secret) {
        headers['X-RelayBox-Signature'] = signWebhookPayload(params.secret, tsSec, rawBody);
      }

      try {
        const resp = await fetch(check.url, {
          method: 'POST',
          headers,
          body: rawBody,
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        lastStatus = resp.status;
        if (resp.ok) {
          store.recordWebhookDelivery({
            id: crypto.randomUUID(),
            webhookId: params.webhookId,
            inboxId: params.inboxId,
            inboxAddress: params.inboxAddress,
            eventId: params.eventId,
            eventType: params.eventType,
            targetUrl: check.url,
            status: 'delivered',
            httpStatus: resp.status,
            attempts: attempt,
            error: null,
            createdAt: new Date().toISOString(),
            deliveredAt: new Date().toISOString(),
          });
          store.recordActivity(
            'webhook:delivered',
            `Webhook delivered (${resp.status}) to ${check.url}`,
            params.inboxAddress,
            `${params.eventType} · Attempt ${attempt}/${maxAttempts}`,
            'success',
          );
          return {
            ok: true,
            httpStatus: resp.status,
            latencyMs: Date.now() - startedAtMs,
            eventId: params.eventId,
            error: null,
          };
        }
        lastErr = `HTTP ${resp.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : 'Network error';
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt === 1 ? 300 : 900));
      }
    }

    store.recordWebhookDelivery({
      id: crypto.randomUUID(),
      webhookId: params.webhookId,
      inboxId: params.inboxId,
      inboxAddress: params.inboxAddress,
      eventId: params.eventId,
      eventType: params.eventType,
      targetUrl: check.url,
      status: 'failed',
      httpStatus: lastStatus,
      attempts: maxAttempts,
      error: lastErr,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
    });
    store.recordActivity(
      'webhook:failed',
      `Webhook delivery failed for ${check.url}`,
      params.inboxAddress,
      lastErr || undefined,
      'error',
    );
    if (params.maxAttempts === undefined) {
      store.database.enqueueJob({
        id: crypto.randomUUID(),
        type: 'webhook.retry',
        idempotencyKey: `webhook-retry:${params.eventId}`,
        maxAttempts: 3,
        runAt: new Date(Date.now() + 60_000).toISOString(),
        payload: {
          webhookId: params.webhookId,
          inboxId: params.inboxId,
          inboxAddress: params.inboxAddress,
          targetUrl: params.targetUrl,
          secret: params.secret,
          eventId: params.eventId,
          eventType: params.eventType,
          payloadObj: params.payloadObj,
        },
      });
    }
    return {
      ok: false,
      httpStatus: lastStatus,
      latencyMs: Date.now() - startedAtMs,
      eventId: params.eventId,
      error: lastErr,
    };
  }

  async function dispatchWebhooksForMessage(
    inboxId: string,
    message: {
      id?: string;
      subject?: string;
      receivedAt?: string;
      extracted?: { primaryOtp?: string | null; primaryActionUrl?: string | null };
    },
  ): Promise<void> {
    const inbox = store.getInboxByIdOrAddress(inboxId);
    if (!inbox) return;

    const registered = store.listWebhooksWithSecrets(inbox.id);
    const targets: {
      webhookId: string | null;
      url: string;
      secret: string | null;
      events: string[];
    }[] = registered.map((w) => ({
      webhookId: w.id,
      url: w.url,
      secret: w.secretPlaintext || null,
      events: w.events?.length ? w.events : ['email.received'],
    }));

    if (inbox.webhookUrl && !targets.some((t) => t.url === inbox.webhookUrl)) {
      targets.push({
        webhookId: null,
        url: inbox.webhookUrl,
        secret: null,
        events: ['email.received'],
      });
    }

    for (const target of targets) {
      if (target.events.includes('email.received') || target.events.includes('*')) {
        const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
        void deliverSingleWebhook({
          webhookId: target.webhookId,
          inboxId: inbox.id,
          inboxAddress: inbox.address,
          targetUrl: target.url,
          secret: target.secret,
          eventId,
          eventType: 'email.received',
          payloadObj: {
            eventId,
            event: 'email.received',
            inbox: { id: inbox.id, address: inbox.address },
            message,
          },
        });
      }

      if (
        message.extracted?.primaryOtp &&
        (target.events.includes('otp.detected') || target.events.includes('*'))
      ) {
        const otpEventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
        void deliverSingleWebhook({
          webhookId: target.webhookId,
          inboxId: inbox.id,
          inboxAddress: inbox.address,
          targetUrl: target.url,
          secret: target.secret,
          eventId: otpEventId,
          eventType: 'otp.detected',
          payloadObj: {
            eventId: otpEventId,
            event: 'otp.detected',
            inbox: { id: inbox.id, address: inbox.address },
            messageId: message.id,
            subject: message.subject,
            otp: message.extracted.primaryOtp,
            actionUrl: message.extracted.primaryActionUrl ?? null,
            receivedAt: message.receivedAt,
          },
        });
      }
    }
  }

  function dispatchWebhooksForInboxCreated(inbox: { id: string; address: string; provider: string }): void {
    for (const hook of store.listGlobalWebhooksWithSecrets()) {
      if (!hook.events.includes('inbox.created') && !hook.events.includes('*')) continue;
      const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;
      void deliverSingleWebhook({
        webhookId: hook.id,
        inboxId: inbox.id,
        inboxAddress: inbox.address,
        targetUrl: hook.url,
        secret: hook.secretPlaintext || null,
        eventId,
        eventType: 'inbox.created',
        payloadObj: {
          eventId,
          event: 'inbox.created',
          inbox,
        },
      });
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(createCorsMiddleware());

  // Security headers (preserve iframe embeddability for AI Studio preview)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '0');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
    if (process.env.NODE_ENV === 'production' && (req.secure || req.header('x-forwarded-proto') === 'https')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(createOriginGuard());

  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Usage telemetry middleware on /api/v1/*
  app.use('/api/v1', (req, res, next) => {
    if (req.path === '/events' || req.path === '/session' || req.path === '/health') {
      next();
      return;
    }
    const start = Date.now();
    res.on('finish', () => {
      try {
        store.recordApiUsage({
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
          authType: req.auth?.authType ?? 'anonymous',
          keyPrefix: req.auth?.key?.prefix ?? null,
        });
      } catch {
        // Non-fatal usage logging error
      }
    });
    next();
  });

  // Production Health Check Endpoint (no secrets exposed)
  app.get('/api/health', async (_req, res) => {
    const dbOk = store.database.ping();
    const liveMxDomains = await fetchLiveMxDomains().catch(() => []);
    const outboundSmtp = getOutboundSmtpConfig();
    const providerOk = liveMxDomains.length > 0;
    const syncOk = store.lastSyncError === null;
    const webhookOk = true;

    const overallStatus: HealthReport['status'] =
      dbOk && (providerOk || smtpBridge.port !== null) ? 'ok' : 'degraded';

    const report: HealthReport = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      components: {
        application: {
          status: 'ok',
          detail: 'Express API & SPA server operational',
        },
        database: {
          status: dbOk ? 'ok' : 'unavailable',
          detail: dbOk
            ? `SQLite (${store.database.getMigrationCount()} migration(s) applied)`
            : 'Database check failed',
        },
        emailProvider: {
          status: providerOk ? 'ok' : 'degraded',
          detail: providerOk
            ? `Live MX active (${liveMxDomains.length} domain(s)); Inbound SMTP ${smtpBridge.port ? `listening on port ${smtpBridge.port}` : 'inactive'}; Outbound relay ${outboundSmtp.configured ? 'configured' : 'not configured'}`
            : `Live MX unreachable; Inbound SMTP ${smtpBridge.port ? `listening on port ${smtpBridge.port}` : 'inactive'}`,
        },
        synchronizationEngine: {
          status: syncOk ? 'ok' : 'degraded',
          detail: store.lastSyncAt
            ? `Last sync ${store.lastSyncAt}`
            : 'Ready (on-demand & SSE background sync)',
        },
        webhookProcessing: {
          status: webhookOk ? 'ok' : 'degraded',
          detail: 'HMAC signing, duplicate event guard, and 3-attempt retry enabled',
        },
      },
    };

    res.status(overallStatus === 'ok' ? 200 : 503).json(report);
  });

  app.get('/api/health/worker', (_req, res) => {
    const heartbeats = store.database.listWorkerHeartbeats();
    const jobs = store.database.listJobs(20).map((job) => ({
      id: job.id,
      type: job.type,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
    }));
    const fresh = heartbeats.some((h) => Date.now() - new Date(h.lastSeen).getTime() < 120_000);
    res.status(fresh ? 200 : 503).json({
      status: fresh ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      workers: heartbeats,
      recentJobs: jobs,
    });
  });

  // Session bootstrap: unauthenticated callers receive READ-ONLY scope only.
  // Elevated scopes require a verified admin passcode or API key supplied in the request body.
  app.post('/api/v1/session', (req, res) => {
    const rl = store.database.consumeRateLimit(`rl:session-bootstrap:${req.ip || 'local'}`, 60);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.resetSec));
      res.status(429).json({ error: 'Too many session requests.', code: 'RATE_LIMITED' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const passcode = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    const apiKey =
      (typeof body.apiKey === 'string' && body.apiKey.trim()) ||
      req.header('x-api-key') ||
      (req.header('authorization')?.toLowerCase().startsWith('bearer ')
        ? req.header('authorization')!.slice(7).trim()
        : '');

    let scopes: ApiKeyScope[] = ['read'];
    let kind: 'ui' | 'elevated' = 'ui';

    if (passcode) {
      if (!store.verifyAdminPasscode(passcode)) {
        store.recordActivity('auth:failed', 'Rejected session bootstrap with invalid passcode', undefined, undefined, 'warning');
        res.status(401).json({ error: 'Invalid session credential.', code: 'INVALID_SESSION_CREDENTIAL' });
        return;
      }
      scopes = ['read', 'write', 'webhooks', 'admin'];
      kind = 'elevated';
    } else if (apiKey) {
      const verified = store.verifyApiKey(apiKey);
      if (!verified) {
        store.recordActivity('auth:failed', 'Rejected session bootstrap with invalid API key', undefined, undefined, 'warning');
        res.status(401).json({ error: 'Invalid session credential.', code: 'INVALID_SESSION_CREDENTIAL' });
        return;
      }
      scopes = verified.scopes;
    }

    const session = issueAuthSession(store, { kind, scopes });
    store.recordActivity(
      'auth:event',
      `Issued ${kind} session token (${scopes.join(', ')})`,
      undefined,
      undefined,
      'info',
    );
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      scopes,
      requireApiKey: requireApiKeyForExternal,
    });
  });

  app.post('/api/v1/session/logout', (req, res) => {
    const auth = req.header('authorization');
    const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const revoked = token ? revokeAuthSession(store, token) : false;
    res.json({ revoked });
  });

  // Legacy health & domains endpoint
  app.get('/api/v1/health', async (_req, res) => {
    const liveMxDomains = await fetchLiveMxDomains();
    res.json({
      status: 'ok',
      liveMxDomains,
      webhookDomains: WEBHOOK_DOMAINS,
      smtpPort: smtpBridge.port,
      requireApiKey: requireApiKeyForExternal,
      inboxCount: store.listInboxes().length,
    });
  });

  const api = express.Router();
  api.use(authenticateApiRequest);

  // Domain MX DNS Validation
  api.get('/domains/validate', requireScope('read'), async (req, res) => {
    const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
    const force = req.query.force === 'true';
    const mx = await checkDomainMxRecords(domain, force);
    const liveMxDomains = await fetchLiveMxDomains();
    res.json({
      ...mx,
      isLiveMxSupported: liveMxDomains.includes(mx.domain),
      isWebhookDomain: isWebhookDomain(mx.domain),
    });
  });

  // Settings
  api.get('/settings', requireScope('read'), async (_req, res) => {
    const liveMxDomains = await fetchLiveMxDomains();
    const outbound = getOutboundSmtpConfig();
    res.json({
      requireApiKey: requireApiKeyForExternal,
      retentionDays: store.getRetentionDays(),
      liveMxDomains,
      webhookDomains: WEBHOOK_DOMAINS,
      smtpPort: smtpBridge.port,
      smtpAuthRequired: smtpBridge.authRequired,
      outboundSmtp: {
        configured: outbound.configured,
        host: outbound.host || null,
        port: outbound.port,
        secure: outbound.secure,
      },
    });
  });

  api.patch('/settings', requireScope('admin'), async (req, res) => {
    if (typeof req.body?.requireApiKey === 'boolean') {
      requireApiKeyForExternal = req.body.requireApiKey;
      store.setRequireApiKeySetting(requireApiKeyForExternal);
      store.recordActivity(
        'auth:event',
        requireApiKeyForExternal
          ? 'Enabled strict API Key authentication for external callers'
          : 'Switched external API access to Open Access',
        undefined,
        undefined,
        'info',
      );
    }
    if (typeof req.body?.retentionDays === 'number') {
      store.setRetentionDays(req.body.retentionDays);
    }
    const liveMxDomains = await fetchLiveMxDomains();
    res.json({
      requireApiKey: requireApiKeyForExternal,
      retentionDays: store.getRetentionDays(),
      liveMxDomains,
      webhookDomains: WEBHOOK_DOMAINS,
      smtpPort: smtpBridge.port,
    });
  });

  // API Keys
  api.get('/keys', requireScope('read'), (_req, res) => {
    res.json({ keys: store.listApiKeys() });
  });

  api.post('/keys', requireScope('admin'), (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : 'Automation API Key';
    const scopes = Array.isArray(req.body?.scopes)
      ? (req.body.scopes as ApiKeyScope[])
      : (['read', 'write', 'webhooks', 'admin'] as ApiKeyScope[]);
    const rateLimitPerMin =
      typeof req.body?.rateLimitPerMin === 'number' ? req.body.rateLimitPerMin : 120;

    const created = store.createApiKey(name, scopes, rateLimitPerMin);
    res.status(201).json({
      key: created.summary,
      plaintextKey: created.plaintextKey,
    });
  });

  api.delete('/keys/:id', requireScope('admin'), (req, res) => {
    const ok = store.revokeApiKey(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'API key not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  // Provision / List Addresses & Inboxes (both /inboxes and /addresses routes supported!)
  const handleListAddresses = async (_req: Request, res: Response) => {
    const liveMxDomains = await fetchLiveMxDomains();
    const list = store.listInboxes();
    res.json({
      inboxes: list,
      addresses: list,
      liveMxDomains,
      webhookDomains: WEBHOOK_DOMAINS,
    });
  };

  const handleCreateAddress = async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const prefix = typeof body.prefix === 'string' ? body.prefix : undefined;
      const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : undefined;
      const ttl = typeof body.ttl === 'string' ? (body.ttl as TtlPreset) : undefined;
      const label = typeof body.label === 'string' ? body.label : undefined;
      const webhookUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined;
      const rawProvider = typeof body.provider === 'string' ? body.provider : undefined;
      const deliverCredentialsEmail = Boolean(body.deliverCredentialsEmail);

      if (
        body.mode === 'alias' ||
        rawProvider === 'gmail-alias' ||
        rawProvider === 'outlook-alias'
      ) {
        const baseEmail =
          typeof body.baseEmail === 'string' && body.baseEmail.trim()
            ? body.baseEmail.trim()
            : prefix && domain
              ? `${prefix}@${domain}`
              : undefined;
        const strategy = body.strategy === 'dot' ? 'dot' : 'plus';
        const tag = typeof body.tag === 'string' ? body.tag : undefined;
        const inbox = store.createAliasInbox({
          baseEmail,
          domain,
          provider:
            rawProvider === 'outlook-alias'
              ? 'outlook-alias'
              : rawProvider === 'gmail-alias'
                ? 'gmail-alias'
                : undefined,
          strategy,
          tag,
          ttl,
          label,
          webhookUrl,
          deliverCredentialsEmail,
        });
        dispatchWebhooksForInboxCreated(inbox);
        res.status(201).json({ inbox, address: inbox });
        return;
      }

      const provider = rawProvider === 'smtp' ? 'smtp' : 'webhook';

      let mode: InboxMode =
        body.mode === 'webhook' || body.mode === 'live-mx'
          ? body.mode
          : domain && isWebhookDomain(domain)
            ? 'webhook'
            : 'live-mx';

      if (mode === 'live-mx') {
        const liveDomains = await fetchLiveMxDomains();
        if (liveDomains.length > 0 && (!domain || liveDomains.includes(domain))) {
          const account = await provisionLiveMxAccount({ prefix, domain });
          const mx = await checkDomainMxRecords(account.domain).catch(() => null);
          const inbox = store.registerLiveMxInbox(account, {
            ttl,
            label,
            webhookUrl,
            mxVerified: mx?.mxVerified ?? true,
            deliverCredentialsEmail,
          });
          dispatchWebhooksForInboxCreated(inbox);
          res.status(201).json({ inbox, address: inbox });
          return;
        }
        if (domain && isWebhookDomain(domain)) {
          mode = 'webhook';
        } else {
          res.status(503).json({
            error: 'Live MX domain is temporarily unavailable. Select a Webhook/SMTP domain or retry.',
          });
          return;
        }
      }

      const inbox = store.createInbox({
        prefix,
        domain,
        ttl,
        label,
        webhookUrl,
        provider,
        deliverCredentialsEmail,
      });
      dispatchWebhooksForInboxCreated(inbox);
      res.status(201).json({ inbox, address: inbox });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to create inbox.';
      res.status(400).json({ error: msg });
    }
  };

  api.get('/inboxes', requireScope('read'), handleListAddresses);
  api.get('/addresses', requireScope('read'), handleListAddresses);
  api.post('/inboxes', requireScope('write'), handleCreateAddress);
  api.post('/addresses', requireScope('write'), handleCreateAddress);

  api.get('/inboxes/:idOrAddress', requireScope('read'), (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    res.json({ inbox });
  });

  api.patch('/addresses/:idOrAddress', requireScope('write'), (req, res) => {
    try {
      const updated = store.updateInbox(req.params.idOrAddress, {
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        status: typeof req.body?.status === 'string' ? req.body.status : undefined,
        webhookUrl:
          req.body?.webhookUrl !== undefined
            ? typeof req.body.webhookUrl === 'string'
              ? req.body.webhookUrl
              : null
            : undefined,
        ttl: typeof req.body?.ttl === 'string' ? (req.body.ttl as TtlPreset) : undefined,
      });
      if (!updated) {
        res.status(404).json({ error: 'Address not found.' });
        return;
      }
      res.json({ inbox: updated, address: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid update.' });
    }
  });

  api.patch('/inboxes/:idOrAddress', requireScope('write'), (req, res) => {
    try {
      const updated = store.updateInbox(req.params.idOrAddress, {
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        status: typeof req.body?.status === 'string' ? req.body.status : undefined,
        webhookUrl:
          req.body?.webhookUrl !== undefined
            ? typeof req.body.webhookUrl === 'string'
              ? req.body.webhookUrl
              : null
            : undefined,
        ttl: typeof req.body?.ttl === 'string' ? (req.body.ttl as TtlPreset) : undefined,
      });
      if (!updated) {
        res.status(404).json({ error: 'Inbox not found.' });
        return;
      }
      res.json({ inbox: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid update.' });
    }
  });

  api.post('/addresses/:idOrAddress/switch', requireScope('read'), (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Address not found.' });
      return;
    }
    store.recordActivity(
      'address:switched',
      `Switched active mailbox to ${inbox.address}`,
      inbox.address,
      undefined,
      'info',
    );
    res.json({ inbox });
  });

  api.post('/inboxes/:idOrAddress/sync', requireScope('write'), async (req, res) => {
    try {
      const result = await store.syncLiveInbox(req.params.idOrAddress, { force: true });
      for (const msg of result.added) {
        void dispatchWebhooksForMessage(msg.inboxId, msg);
      }
      res.json({
        inbox: result.inbox,
        newMessages: result.added.length,
        messages: store.listMessages(result.inbox.id),
      });
    } catch (err) {
      if (err instanceof MailTmRateLimitError) {
        res.setHeader('Retry-After', String(err.retryAfterSec));
        res.status(429).json({
          error: err.message,
          retryAfterSeconds: err.retryAfterSec,
        });
        return;
      }
      const msg = err instanceof Error ? err.message : 'Sync failed.';
      const statusCode = /not found/i.test(msg) ? 404 : 502;
      res.status(statusCode).json({ error: msg });
    }
  });

  api.post('/inboxes/:idOrAddress/import-messages', requireScope('write'), (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }

    const rawList = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const beforeIds = new Set(store.listMessages(inbox.id, { folder: 'all', limit: 500 }).map((m) => m.id));
    let addedCount = 0;

    for (const item of rawList.slice(0, 30)) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      try {
        const msg = store.ingestMessage({
          to: inbox.address,
          from: typeof rec.from === 'string' ? rec.from : undefined,
          fromName: typeof rec.fromName === 'string' ? rec.fromName : undefined,
          subject: typeof rec.subject === 'string' ? rec.subject : '(No Subject)',
          text: typeof rec.text === 'string' ? rec.text : undefined,
          html: typeof rec.html === 'string' ? rec.html : undefined,
          headers:
            rec.headers && typeof rec.headers === 'object'
              ? (rec.headers as Record<string, string>)
              : undefined,
          source: rec.source === 'gmail' ? 'gmail' : 'api',
          remoteId: typeof rec.remoteId === 'string' ? rec.remoteId : undefined,
          receivedAt: typeof rec.receivedAt === 'string' ? rec.receivedAt : undefined,
        });
        if (!beforeIds.has(msg.id)) {
          beforeIds.add(msg.id);
          addedCount += 1;
          void dispatchWebhooksForMessage(inbox.id, msg);
        }
      } catch {
        // Skip invalid individual entry
      }
    }

    const updatedInbox = store.markInboxSynced(inbox.id, addedCount) ?? inbox;
    res.json({
      inbox: updatedInbox,
      newMessages: addedCount,
      messages: store.listMessages(inbox.id, { folder: 'all', limit: 200 }),
    });
  });

  api.patch('/inboxes/:idOrAddress/webhook', requireScope('webhooks'), (req, res) => {
    try {
      const webhookUrl =
        typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl : null;
      const updated = store.updateInboxWebhook(req.params.idOrAddress, webhookUrl);
      if (!updated) {
        res.status(404).json({ error: 'Inbox not found.' });
        return;
      }
      res.json({ inbox: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid webhook URL.';
      res.status(400).json({ error: msg });
    }
  });

  api.post('/inboxes/:idOrAddress/webhook/test', requireScope('webhooks'), async (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    const targetUrl =
      typeof req.body?.webhookUrl === 'string' && req.body.webhookUrl.trim()
        ? req.body.webhookUrl.trim()
        : inbox.webhookUrl;
    if (!targetUrl) {
      res.status(400).json({ error: 'No webhook URL configured for this inbox.' });
      return;
    }
    const eventId = `evt_test_${crypto.randomBytes(6).toString('hex')}`;
    const result = await deliverSingleWebhook({
      webhookId: null,
      inboxId: inbox.id,
      inboxAddress: inbox.address,
      targetUrl,
      secret: null,
      eventId,
      eventType: 'email.received',
      maxAttempts: 1,
      payloadObj: {
        eventId,
        event: 'email.received',
        test: true,
        inbox: { id: inbox.id, address: inbox.address },
        message: {
          id: 'msg_test_sample',
          subject: 'RelayBox Webhook Connection Test',
          from: 'automation@relaybox.dev',
          to: inbox.address,
          extracted: { primaryOtp: '482910', primaryActionUrl: 'https://relaybox.dev/verify?test=1' },
          receivedAt: new Date().toISOString(),
        },
      },
    });
    res.status(result.ok ? 200 : 502).json(result);
  });

  const handleDeleteAddress = (req: Request, res: Response) => {
    const ok = store.deleteInbox(req.params.idOrAddress);
    if (!ok) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    res.json({ deleted: true });
  };
  api.delete('/inboxes/:idOrAddress', requireScope('write'), handleDeleteAddress);
  api.delete('/addresses/:idOrAddress', requireScope('write'), handleDeleteAddress);

  api.post('/inboxes/:idOrAddress/clear', requireScope('write'), (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    const deletedCount = store.clearInboxMessages(inbox.id);
    res.json({ cleared: deletedCount });
  });

  // Messages in an inbox
  api.get('/inboxes/:idOrAddress/messages', requireScope('read'), async (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    if (inbox.mode === 'live-mx' && req.query.sync !== 'false') {
      await store.syncLiveInbox(inbox.id).catch(() => undefined);
    }
    const folderParam = typeof req.query.folder === 'string' ? (req.query.folder as MessageFolder | 'all') : 'all';
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

    const { messages, total } = store.queryMessagesPaginated({
      inboxId: inbox.id,
      folder: folderParam,
      subject: typeof req.query.subject === 'string' ? req.query.subject : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      unreadOnly: req.query.unread === 'true',
      starredOnly: req.query.starred === 'true',
      hasOtp: req.query.hasOtp === 'true',
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      limit,
      offset,
    });
    res.json({
      inbox: store.getInboxByIdOrAddress(inbox.id) ?? inbox,
      messages,
      total,
      limit,
      offset,
    });
  });

  // Global paginated messages endpoint (Phase 4 API spec)
  api.get('/messages', requireScope('read'), (req, res) => {
    const inboxIdRaw = typeof req.query.inboxId === 'string' ? req.query.inboxId : undefined;
    const inbox = inboxIdRaw ? store.getInboxByIdOrAddress(inboxIdRaw) : null;
    if (inboxIdRaw && !inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    const folder = typeof req.query.folder === 'string' ? (req.query.folder as MessageFolder | 'all') : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

    const { messages, total } = store.queryMessagesPaginated({
      inboxId: inbox?.id,
      folder,
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      unreadOnly: req.query.unread === 'true',
      starredOnly: req.query.starred === 'true',
      hasOtp: req.query.hasOtp === 'true',
      limit,
      offset,
    });
    res.json({ messages, total, limit, offset });
  });

  // Latest message shortcut for automated assertions
  api.get('/inboxes/:idOrAddress/latest', requireScope('read'), async (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    if (inbox.mode === 'live-mx') {
      await store.syncLiveInbox(inbox.id).catch(() => undefined);
    }
    const message = store.getLatestMessage(inbox.id, {
      folder: 'inbox',
      subject: typeof req.query.subject === 'string' ? req.query.subject : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
    });
    if (!message) {
      res.status(404).json({ error: 'No matching messages in inbox.' });
      return;
    }
    res.json({
      message,
      otp: message.extracted.primaryOtp,
      actionUrl: message.extracted.primaryActionUrl,
    });
  });

  // Long-poll wait endpoint for Playwright / Cypress / CI tests
  api.get('/inboxes/:idOrAddress/wait', requireScope('read'), async (req, res) => {
    const inbox = store.getInboxByIdOrAddress(req.params.idOrAddress);
    if (!inbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    const timeoutMs = Number(req.query.timeout ?? 15000);
    const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;

    try {
      const message = await store.waitForMessage(inbox.id, {
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15000,
        subject,
        from,
        since,
      });
      if (!message) {
        res.status(408).json({
          error: 'Timed out waiting for matching email.',
          timedOut: true,
        });
        return;
      }
      res.json({
        message,
        otp: message.extracted.primaryOtp,
        actionUrl: message.extracted.primaryActionUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Wait failed.';
      res.status(400).json({ error: msg });
    }
  });

  // Real inbound email ingestion (REST JSON + Mailgun/SendGrid/Postmark webhook formats)
  const handleIngest = (req: Request, res: Response) => {
    try {
      // Optional HMAC signature verification if WEBHOOK_INBOUND_SECRET is configured
      const inboundSecret = process.env.WEBHOOK_INBOUND_SECRET?.trim();
      if (inboundSecret && req.path.includes('inbound')) {
        const sig = req.header('x-relaybox-signature');
        const check = verifyWebhookSignature(inboundSecret, sig, req.rawBody || JSON.stringify(req.body ?? {}));
        if (!check.ok) {
          store.recordActivity('webhook:failed', 'Rejected forged inbound webhook', undefined, check.reason, 'error');
          res.status(401).json({ error: check.reason, code: 'INVALID_WEBHOOK_SIGNATURE' });
          return;
        }
      }

      // Duplicate event prevention via X-Event-Id / Idempotency-Key
      const eventId = req.header('x-event-id') || req.header('idempotency-key');
      if (eventId && eventId.trim()) {
        const isNew = store.markInboundEventSeen(eventId.trim());
        if (!isNew) {
          res.status(200).json({ duplicate: true, eventId: eventId.trim() });
          return;
        }
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const toRaw =
        (typeof body.to === 'string' && body.to) ||
        (typeof body.recipient === 'string' && body.recipient) ||
        (typeof body.To === 'string' && body.To) ||
        '';
      const fromRaw =
        (typeof body.from === 'string' && body.from) ||
        (typeof body.sender === 'string' && body.sender) ||
        (typeof body.From === 'string' && body.From) ||
        undefined;
      const subjectRaw =
        (typeof body.subject === 'string' && body.subject) ||
        (typeof body.Subject === 'string' && body.Subject) ||
        undefined;
      const textRaw =
        (typeof body.text === 'string' && body.text) ||
        (typeof body['body-plain'] === 'string' && body['body-plain']) ||
        (typeof body.TextBody === 'string' && body.TextBody) ||
        undefined;
      const htmlRaw =
        (typeof body.html === 'string' && body.html) ||
        (typeof body['body-html'] === 'string' && body['body-html']) ||
        (typeof body.HtmlBody === 'string' && body.HtmlBody) ||
        undefined;

      if (!toRaw.trim()) {
        res.status(400).json({ error: 'Field "to" (or "recipient") email address is required.' });
        return;
      }
      if (!subjectRaw && !textRaw && !htmlRaw) {
        res.status(400).json({ error: 'Provide at least "subject", "text", or "html".' });
        return;
      }

      const payload: IngestEmailPayload = {
        to: toRaw,
        from: fromRaw,
        fromName: typeof body.fromName === 'string' ? body.fromName : undefined,
        subject: subjectRaw || '(No Subject)',
        text: textRaw,
        html: htmlRaw,
        headers:
          body.headers && typeof body.headers === 'object'
            ? (body.headers as Record<string, string>)
            : undefined,
        attachments: Array.isArray(body.attachments) ? (body.attachments as IngestEmailPayload['attachments']) : undefined,
        autoCreateInbox: Boolean(body.autoCreateInbox),
        source: req.path.includes('inbound') ? 'webhook' : 'api',
        remoteId: typeof body.remoteId === 'string' ? body.remoteId : undefined,
      };

      const message = store.ingestMessage(payload);
      void dispatchWebhooksForMessage(message.inboxId, message);
      res.status(201).json({
        message,
        otp: message.extracted.primaryOtp,
        actionUrl: message.extracted.primaryActionUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to ingest email.';
      res.status(400).json({ error: msg });
    }
  };

  api.post('/messages', requireScope('write'), handleIngest);
  api.post('/inbound', requireScope('webhooks'), handleIngest);

  // Compose Draft or Send Internal / Outbound message
  api.post('/messages/send', requireScope('write'), (req, res) => {
    try {
      const body = req.body ?? {};
      const inboxIdOrAddress = String(body.inboxId || body.from || '');
      const to = String(body.to || '');
      const subject = String(body.subject || '');
      const text = String(body.text || '');
      const html = typeof body.html === 'string' ? body.html : undefined;
      const mode = body.mode === 'drafts' ? 'drafts' : 'sent';

      if (!inboxIdOrAddress) {
        res.status(400).json({ error: 'Sender inboxId is required.' });
        return;
      }

      const msg = store.saveDraftOrSentMessage({
        inboxIdOrAddress,
        to,
        subject,
        text,
        html,
        mode,
      });
      res.status(201).json({ message: msg });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save/send message.' });
    }
  });

  // Single message operations
  api.get('/messages/:messageId', requireScope('read'), (req, res) => {
    const message = store.getMessage(req.params.messageId);
    if (!message) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }
    res.json({ message });
  });

  api.patch('/messages/:messageId', requireScope('write'), (req, res) => {
    const patch: { read?: boolean; starred?: boolean; folder?: MessageFolder } = {};
    if (typeof req.body?.read === 'boolean') patch.read = req.body.read;
    if (typeof req.body?.starred === 'boolean') patch.starred = req.body.starred;
    if (
      typeof req.body?.folder === 'string' &&
      ['inbox', 'sent', 'drafts', 'spam', 'trash'].includes(req.body.folder)
    ) {
      patch.folder = req.body.folder as MessageFolder;
    }

    const updated = store.updateMessage(req.params.messageId, patch);
    if (!updated) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }
    res.json({ message: updated });
  });

  api.post('/messages/:messageId/restore', requireScope('write'), (req, res) => {
    const updated = store.updateMessage(req.params.messageId, { folder: 'inbox' });
    if (!updated) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }
    res.json({ message: updated });
  });

  api.delete('/messages/:messageId', requireScope('write'), (req, res) => {
    const permanent = req.query.permanent === 'true';
    const ok = store.deleteMessage(req.params.messageId, permanent);
    if (!ok) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }
    res.json({ deleted: true, permanent });
  });

  api.post('/messages/bulk', requireScope('write'), (req, res) => {
    const messageIds = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    const action = req.body?.action;
    const validActions = ['markRead', 'markUnread', 'star', 'unstar', 'delete', 'restore'];

    if (messageIds.length === 0) {
      res.status(400).json({ error: 'messageIds array is required.' });
      return;
    }
    if (typeof action !== 'string' || !validActions.includes(action)) {
      res.status(400).json({ error: 'Invalid bulk action.' });
      return;
    }

    const permanent = Boolean(req.body?.permanent);
    const result = store.bulkActionMessages(
      messageIds,
      action as 'markRead' | 'markUnread' | 'star' | 'unstar' | 'delete' | 'restore',
      { permanent },
    );
    res.json(result);
  });

  // OTP Endpoint
  api.get('/otp', requireScope('read'), (req, res) => {
    const inboxParam = typeof req.query.inboxId === 'string' ? req.query.inboxId : undefined;
    const resolvedInbox = inboxParam ? store.getInboxByIdOrAddress(inboxParam) : null;
    if (inboxParam && !resolvedInbox) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }

    const kind =
      req.query.kind === 'otp' || req.query.kind === 'links' ? req.query.kind : 'all';
    const items = store.listOtpEntries({
      inboxId: resolvedInbox?.id,
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      kind,
      limit: Math.min(Number(req.query.limit ?? 100) || 100, 300),
    });
    res.json({ items, total: items.length });
  });

  // Webhooks Management & Delivery Logs
  api.get('/webhooks', requireScope('webhooks'), (req, res) => {
    const inboxId = typeof req.query.inboxId === 'string' ? req.query.inboxId : undefined;
    res.json({ webhooks: store.listWebhooks(inboxId) });
  });

  api.post('/webhooks', requireScope('webhooks'), (req, res) => {
    try {
      const url = typeof req.body?.url === 'string' ? req.body.url : '';
      const inboxIdOrAddress =
        typeof req.body?.inboxId === 'string' ? req.body.inboxId : undefined;
      const events = Array.isArray(req.body?.events) ? (req.body.events as string[]) : undefined;
      const created = store.createWebhook({ url, inboxIdOrAddress, events });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid webhook configuration.' });
    }
  });

  api.patch('/webhooks/:id', requireScope('webhooks'), (req, res) => {
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined;
    const events = Array.isArray(req.body?.events)
      ? (req.body.events as string[]).filter((e) =>
          ['email.received', 'otp.detected', 'inbox.created', '*'].includes(e),
        )
      : undefined;
    const updated = store.updateWebhook(req.params.id, { enabled, events });
    if (!updated) {
      res.status(404).json({ error: 'Webhook not found.' });
      return;
    }
    res.json({ webhook: updated });
  });

  api.post('/webhooks/:id/test', requireScope('webhooks'), async (req, res) => {
    const hook = store.getWebhookWithSecret(req.params.id);
    if (!hook) {
      res.status(404).json({ error: 'Webhook not found.' });
      return;
    }
    const eventId = `evt_test_${crypto.randomBytes(6).toString('hex')}`;
    const eventType = hook.events.includes('otp.detected') ? 'otp.detected' : 'email.received';
    const result = await deliverSingleWebhook({
      webhookId: hook.id,
      inboxId: hook.inboxId || 'global',
      inboxAddress: hook.inboxAddress || 'global@relaybox.dev',
      targetUrl: hook.url,
      secret: hook.secretPlaintext || null,
      eventId,
      eventType,
      maxAttempts: 1,
      payloadObj: {
        eventId,
        event: eventType,
        test: true,
        inbox: {
          id: hook.inboxId || 'global',
          address: hook.inboxAddress || 'global@relaybox.dev',
        },
        otp: '482910',
        message: {
          id: 'msg_test_sample',
          subject: 'RelayBox Signed Webhook Test',
          from: 'automation@relaybox.dev',
          to: hook.inboxAddress || 'global@relaybox.dev',
          extracted: { primaryOtp: '482910', primaryActionUrl: 'https://relaybox.dev/verify?test=1' },
          receivedAt: new Date().toISOString(),
        },
      },
    });
    res.status(result.ok ? 200 : 502).json(result);
  });

  api.delete('/webhooks/:id', requireScope('webhooks'), (req, res) => {
    const ok = store.deleteWebhook(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Webhook not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  api.get('/webhooks/deliveries', requireScope('webhooks'), (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ deliveries: store.listWebhookDeliveries(limit) });
  });

  // SMTP Status & Real Connection Tester
  api.get('/smtp/status', requireScope('read'), (_req, res) => {
    const outbound = getOutboundSmtpConfig();
    res.json({
      inbound: {
        host: '127.0.0.1',
        port: smtpBridge.port,
        protocol: 'ESMTP',
        authRequired: smtpBridge.authRequired,
        tls: false,
      },
      outbound: {
        configured: outbound.configured,
        host: outbound.host || null,
        port: outbound.port,
        secure: outbound.secure,
      },
    });
  });

  api.post('/smtp/test', requireScope('admin'), async (req, res) => {
    const host =
      typeof req.body?.host === 'string' && req.body.host.trim()
        ? req.body.host.trim()
        : '127.0.0.1';
    const port = Number(req.body?.port ?? smtpBridge.port ?? 2525);
    const secure = Boolean(req.body?.secure);
    const result = await testSmtpConnection({ host, port, secure });
    store.recordActivity(
      'smtp:test',
      result.ok
        ? `SMTP connection verified (${host}:${port}, ${result.latencyMs}ms)`
        : `SMTP connection failed (${host}:${port})`,
      undefined,
      result.ok ? result.banner : result.error,
      result.ok ? 'success' : 'error',
    );
    res.status(result.ok ? 200 : 502).json(result);
  });

  // Activity Log (supports both /activities and /activity + export)
  const handleQueryActivity = (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const result = store.queryActivities({
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
      limit,
      offset,
    });
    res.json({ ...result, limit, offset });
  };

  api.get('/activities', requireScope('read'), handleQueryActivity);
  api.get('/activity', requireScope('read'), handleQueryActivity);

  api.get('/activity/export', requireScope('read'), (req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const { activities } = store.queryActivities({ limit: 500 });
    if (format === 'csv') {
      const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
      const lines = ['id,timestamp,type,status,inboxAddress,summary,detail'];
      for (const a of activities) {
        lines.push(
          [
            escapeCsv(a.id),
            escapeCsv(a.timestamp),
            escapeCsv(a.type),
            escapeCsv(a.status),
            escapeCsv(a.inboxAddress || ''),
            escapeCsv(a.summary),
            escapeCsv(a.detail || ''),
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="relaybox-activity.csv"');
      res.send(lines.join('\n'));
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="relaybox-activity.json"');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), activities }, null, 2));
  });

  // API Usage Logs
  api.get('/usage', requireScope('read'), (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ usage: store.listApiUsageLogs(limit) });
  });

  // Real-time Server-Sent Events stream
  api.get('/events', requireScope('read'), (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (eventName: string, data: unknown) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('connected', { timestamp: new Date().toISOString() });

    const unsubscribe = store.subscribe((ev) => {
      sendEvent('store', ev);
    });

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.use('/api/v1', api);

  // ---------------------------------------------------------------------------
  // Separated Backend Admin API (/api/admin/*)
  // ---------------------------------------------------------------------------
  const adminApi = express.Router();

  const requireAdminSession = createAdminAuthMiddleware(store);
  const issueAdminToken = () =>
    issueAuthSession(store, { kind: 'admin', scopes: ['admin'] }).token;

  adminApi.get('/status', (req, res) => {
    const token = extractAdminToken(req);
    res.json({
      configured: store.isAdminPasscodeConfigured(),
      authenticated: isAdminTokenValid(store, token),
      envManaged: store.hasEnvAdminPasscode(),
    });
  });

  adminApi.post('/setup', (req, res) => {
    const rl = store.database.consumeRateLimit(`rl:admin-setup:${req.ip || 'local'}`, 10);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.resetSec));
      res.status(429).json({ error: 'Too many setup attempts. Retry later.', code: 'RATE_LIMITED' });
      return;
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    try {
      const claimed = store.claimInitialAdminPasscode(passcode);
      if (!claimed) {
        res.status(409).json({
          error: 'ระบบหลังบ้านถูกตั้งค่ารหัสผ่านไว้แล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านเดิม',
        });
        return;
      }
      const token = issueAdminToken();
      res.status(201).json({
        token,
        status: {
          configured: true,
          authenticated: true,
          envManaged: false,
        },
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถตั้งรหัสผ่านผู้ดูแลได้',
      });
    }
  });

  adminApi.post('/login', (req, res) => {
    const rl = store.database.consumeRateLimit(`rl:admin-login:${req.ip || 'local'}`, 15);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.resetSec));
      res.status(429).json({ error: 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่', code: 'RATE_LIMITED' });
      return;
    }
    if (!store.isAdminPasscodeConfigured()) {
      res.status(400).json({
        error: 'ยังไม่ได้ตั้งรหัสผ่านระบบหลังบ้าน กรุณาตั้งรหัสผ่านครั้งแรกก่อน',
      });
      return;
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!passcode || !store.verifyAdminPasscode(passcode)) {
      store.recordActivity(
        'auth:failed',
        'Failed Admin Console login attempt',
        undefined,
        undefined,
        'warning',
      );
      res.status(401).json({ error: 'รหัสผ่านระบบหลังบ้านไม่ถูกต้อง' });
      return;
    }
    const token = issueAdminToken();
    store.recordActivity('auth:event', 'Admin Console login succeeded', undefined, undefined, 'info');
    res.json({
      token,
      status: {
        configured: true,
        authenticated: true,
        envManaged: store.hasEnvAdminPasscode(),
      },
    });
  });

  adminApi.post('/logout', (req, res) => {
    const token = extractAdminToken(req);
    if (token) revokeAuthSession(store, token);
    res.json({ ok: true });
  });

  adminApi.use(requireAdminSession);

  adminApi.get('/overview', async (_req, res) => {
    const liveMxDomains = await fetchLiveMxDomains().catch(() => []);
    const overview = store.getAdminOverview({
      requireApiKey: requireApiKeyForExternal,
      smtpPort: smtpBridge.port,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
    res.json({
      overview,
      liveMxDomains,
      webhookDomains: WEBHOOK_DOMAINS,
    });
  });

  adminApi.get('/inboxes', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const provider = typeof req.query.provider === 'string' ? req.query.provider : 'all';
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';

    let items = store.listInboxes();
    if (provider !== 'all') {
      items = items.filter((i) => i.provider === provider);
    }
    if (status !== 'all') {
      items = items.filter((i) => i.status === status);
    }
    if (q) {
      items = items.filter(
        (i) =>
          i.address.toLowerCase().includes(q) ||
          i.label.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q),
      );
    }
    res.json({ inboxes: items, total: items.length });
  });

  adminApi.patch('/inboxes/:idOrAddress', (req, res) => {
    try {
      const updated = store.updateInbox(req.params.idOrAddress, {
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        status: typeof req.body?.status === 'string' ? req.body.status : undefined,
        webhookUrl:
          req.body?.webhookUrl !== undefined
            ? typeof req.body.webhookUrl === 'string'
              ? req.body.webhookUrl
              : null
            : undefined,
        ttl: typeof req.body?.ttl === 'string' ? (req.body.ttl as TtlPreset) : undefined,
      });
      if (!updated) {
        res.status(404).json({ error: 'Inbox not found.' });
        return;
      }
      res.json({ inbox: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid update.' });
    }
  });

  adminApi.delete('/inboxes/:idOrAddress', (req, res) => {
    const ok = store.deleteInbox(req.params.idOrAddress);
    if (!ok) {
      res.status(404).json({ error: 'Inbox not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  adminApi.post('/maintenance/prune', (_req, res) => {
    const result = store.runMaintenancePrune();
    store.recordActivity(
      'inbox:synced',
      `Admin maintenance prune completed (${result.expiredInboxes} expired, ${result.deletedMessages} old msgs)`,
      undefined,
      undefined,
      'info',
    );
    res.json(result);
  });

  adminApi.post('/passcode', (req, res) => {
    try {
      const currentPasscode =
        typeof req.body?.currentPasscode === 'string' ? req.body.currentPasscode : '';
      const newPasscode = typeof req.body?.newPasscode === 'string' ? req.body.newPasscode : '';
      store.updateAdminPasscode(currentPasscode, newPasscode);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถเปลี่ยนรหัสผ่านได้',
      });
    }
  });

  app.use('/api/admin', adminApi);

  async function initStarterAndBackground() {
    if (!options.skipStarterInbox && store.listInboxes().length === 0) {
      try {
        const account = await provisionLiveMxAccount();
        const mx = await checkDomainMxRecords(account.domain).catch(() => null);
        store.registerLiveMxInbox(account, {
          ttl: '24h',
          label: 'Primary Temp Inbox',
          mxVerified: mx?.mxVerified ?? true,
        });
      } catch {
        if (store.listInboxes().length === 0) {
          store.createInbox({
            domain: WEBHOOK_DOMAINS[0],
            ttl: '24h',
            label: 'Primary Inbox',
          });
        }
      }
    }
  }

  return {
    app,
    store,
    smtpBridge,
    initStarterAndBackground,
    close: () => {
      smtpBridge.close();
      store.database.db.close();
    },
  };
}

async function startMainServer(): Promise<void> {
  const PORT = Number(process.env.PORT || 3000);
  const IS_PROD = process.env.NODE_ENV === 'production';

  const envReport = validateProductionEnv();
  for (const warning of envReport.warnings) console.warn(`[env] ${warning}`);
  if (!envReport.ok) {
    for (const error of envReport.errors) console.error(`[env] ${error}`);
    process.exitCode = 1;
    return;
  }

  const instance = createAppInstance();
  await instance.initStarterAndBackground();

  const timers: ReturnType<typeof setInterval>[] = [];
  timers.push(
    setInterval(() => {
      if (instance.store.hasSubscribers()) {
        void instance.store.syncAllLiveInboxes();
      }
    }, 12000),
  );
  timers.push(
    setInterval(() => {
      instance.store.database.pruneRetention(instance.store.getRetentionDays());
      instance.store.database.pruneExpiredSessions();
      instance.store.database.pruneRateLimits();
    }, 60 * 60 * 1000),
  );

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    instance.app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    instance.app.use(express.static(distDir));
    instance.app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Not found.' });
        return;
      }
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build artifacts not found. Run npm run build.');
      }
    });
  }

  const httpServer = instance.app.listen(PORT, '0.0.0.0', () => {
    console.log(`RelayBox Enterprise server listening on http://0.0.0.0:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}; closing server and database`);
    for (const timer of timers) clearInterval(timer);
    httpServer.close(() => {
      instance.close();
      process.exit(0);
    });
    setTimeout(() => {
      instance.close();
      process.exit(0);
    }, 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

// Start server automatically when executed directly (not imported by integration tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isMainModule) {
  void startMainServer();
}
