import 'dotenv/config';
import crypto from 'node:crypto';
import { signWebhookPayload } from './server/crypto.ts';
import { validateProductionEnv } from './server/env.ts';
import { validateOutboundWebhookTarget } from './server/parser.ts';
import { FlowMailStore } from './server/store.ts';
import type { QueuedJob } from './server/db.ts';

const workerId = `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const store = new FlowMailStore();
let processedJobs = 0;
let stopped = false;

function requireString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function deliverWebhookRetry(job: QueuedJob): Promise<{ ok: boolean; error: string | null }> {
  const p = job.payload;
  const eventId = requireString(p.eventId, job.id);
  const targetUrl = requireString(p.targetUrl);
  const eventType = requireString(p.eventType, 'email.received');
  const secret = p.secret ? requireString(p.secret) : null;
  const rawBody = JSON.stringify(p.payloadObj ?? p);

  const check = await validateOutboundWebhookTarget(targetUrl);
  if (!check.ok) return { ok: false, error: check.error };

  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-FlowMail-Event': eventType,
    'X-RelayBox-Event': eventType,
    'X-RelayBox-Event-Id': eventId,
    'X-FlowMail-Inbox': requireString(p.inboxAddress, 'global@relaybox.dev'),
  };
  if (secret) {
    headers['X-RelayBox-Signature'] = signWebhookPayload(secret, timestamp, rawBody);
  }

  let httpStatus: number | null = null;
  let error: string | null = null;
  let ok = false;
  try {
    const response = await fetch(check.url, {
      method: 'POST',
      headers,
      body: rawBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    httpStatus = response.status;
    ok = response.ok;
    if (!ok) error = `HTTP ${response.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : 'Network error';
  }

  store.recordWebhookDelivery({
    id: crypto.randomUUID(),
    webhookId: p.webhookId ? requireString(p.webhookId) : null,
    inboxId: requireString(p.inboxId, 'global'),
    inboxAddress: requireString(p.inboxAddress, 'global@relaybox.dev'),
    eventId,
    eventType,
    targetUrl: check.url,
    status: ok ? 'delivered' : 'failed',
    httpStatus,
    attempts: job.attempts + 1,
    error,
    createdAt: new Date().toISOString(),
    deliveredAt: ok ? new Date().toISOString() : null,
  });
  return { ok, error };
}

async function processJob(job: QueuedJob): Promise<void> {
  if (job.type === 'webhook.retry') {
    const result = await deliverWebhookRetry(job);
    if (result.ok) {
      store.database.completeJob(job.id);
    } else {
      const delay = Math.min(60 * 2 ** job.attempts, 3600);
      const outcome = store.database.failJob(job.id, result.error || 'Unknown error', delay);
      store.recordActivity(
        'webhook:retry',
        `${outcome === 'dead' ? 'Webhook retry exhausted' : 'Webhook retry scheduled'} for ${requireString(job.payload.targetUrl)}`,
        asOptionalString(job.payload.inboxAddress),
        result.error || undefined,
        outcome === 'dead' ? 'error' : 'warning',
      );
    }
    return;
  }

  if (job.type === 'mailbox.sync') {
    await store.syncAllLiveInboxes();
    store.database.completeJob(job.id);
    return;
  }

  if (job.type === 'retention.prune') {
    const pruned = store.database.pruneRetention(store.getRetentionDays());
    store.database.pruneExpiredSessions();
    store.database.pruneRateLimits();
    store.database.recoverStaleJobs();
    store.recordActivity(
      'system:maintenance',
      `Pruned ${pruned.deletedMessages} message(s) and ${pruned.deletedLogs} log(s)`,
      'system@relaybox.dev',
      undefined,
      'info',
    );
    store.database.completeJob(job.id);
    return;
  }

  store.database.failJob(job.id, `Unknown job type: ${job.type}`, 300);
}

async function processQueue(): Promise<void> {
  const jobs = store.database.claimJobs(workerId, 4);
  for (const job of jobs) {
    if (stopped) break;
    try {
      await processJob(job);
    } catch (err) {
      store.database.failJob(job.id, err instanceof Error ? err.message : 'Worker error', 60);
    }
    processedJobs += 1;
  }
  store.database.recordWorkerHeartbeat(workerId, processedJobs);
}

async function startWorker(): Promise<void> {
  const report = validateProductionEnv();
  for (const warning of report.warnings) console.warn(`[worker] ${warning}`);
  if (!report.ok) {
    for (const error of report.errors) console.error(`[worker] ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[worker] ${workerId} started; migrations=${store.database.getMigrationCount()}`);
  store.database.recordWorkerHeartbeat(workerId, 0);

  const queueTimer = setInterval(() => {
    void processQueue();
  }, 2000);
  const syncTimer = setInterval(() => {
    void store.syncAllLiveInboxes().catch((err: unknown) => {
      console.error('[worker] live MX sync failed:', err instanceof Error ? err.message : err);
    });
  }, 60_000);
  const retentionTimer = setInterval(() => {
    store.database.pruneRetention(store.getRetentionDays());
    store.database.pruneExpiredSessions();
    store.database.pruneRateLimits();
    store.database.recoverStaleJobs();
  }, 60 * 60 * 1000);

  const shutdown = (signal: string) => {
    if (stopped) return;
    stopped = true;
    console.log(`[worker] received ${signal}; stopping after current jobs`);
    clearInterval(queueTimer);
    clearInterval(syncTimer);
    clearInterval(retentionTimer);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  void processQueue();
}

void startWorker();
