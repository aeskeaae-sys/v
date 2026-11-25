import crypto from 'node:crypto';
import {
  GMAIL_ALIAS_DOMAINS,
  OUTLOOK_ALIAS_DOMAINS,
  WEBHOOK_DOMAINS,
  type ActivityEvent,
  type ActivityStatus,
  type AdminOverview,
  type ApiKeyScope,
  type ApiKeySummary,
  type ApiUsageLog,
  type EmailAttachment,
  type EmailMessage,
  type Inbox,
  type InboxMode,
  type InboxProvider,
  type InboxStatus,
  type IngestEmailPayload,
  type MessageFolder,
  type OtpEntry,
  type TtlPreset,
  type WebhookConfig,
  type WebhookDeliveryLog,
} from '../shared/types.ts';
import {
  MailboxDatabase,
  type ActivityQueryParams,
  type MessageQueryParams,
  type StoredInboxRecord,
} from './db.ts';
import { checkDomainMxRecords } from './dns.ts';
import {
  MailTmRateLimitError,
  deleteLiveMxAccount,
  deleteLiveMxMessage,
  fetchNewLiveMxMessages,
  type ProvisionedLiveAccount,
} from './mailtm.ts';
import { redactOtpCode, redactSensitiveUrl } from './crypto.ts';
import {
  buildSnippet,
  classifySpam,
  computeMessageContentHash,
  computeThreadId,
  extractArtifacts,
  generateRandomLocalPart,
  normalizeEmailAddress,
  stripHtmlToText,
  validateAttachment,
  validateOutboundWebhookUrl,
} from './parser.ts';

export interface StoreEvent {
  type:
    | 'inbox:created'
    | 'inbox:updated'
    | 'inbox:deleted'
    | 'inbox:cleared'
    | 'inbox:synced'
    | 'email:received'
    | 'message:updated'
    | 'message:deleted'
    | 'webhook:delivery'
    | 'activity';
  inboxId?: string;
  inboxAddress?: string;
  inbox?: Inbox;
  message?: EmailMessage;
  messageId?: string;
  delivery?: WebhookDeliveryLog;
  activity?: ActivityEvent;
}

export interface CreateWebhookInboxInput {
  prefix?: string;
  domain?: string;
  ttl?: TtlPreset;
  label?: string;
  webhookUrl?: string;
  provider?: InboxProvider;
}

export interface MessageFilterOptions {
  folder?: MessageFolder | 'all';
  subject?: string;
  from?: string;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  hasOtp?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  subject?: string;
  from?: string;
  since?: string;
}

interface PendingWaiter {
  inboxId: string;
  subject?: string;
  from?: string;
  resolve: (msg: EmailMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TTL_MS: Record<TtlPreset, number | null> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  never: null,
};

function hashKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export function isWebhookDomain(domain: string): boolean {
  return (WEBHOOK_DOMAINS as readonly string[]).includes(domain.toLowerCase());
}

function toPublicInbox(stored: StoredInboxRecord): Inbox {
  const { credentials: _hidden, ...publicFields } = stored;
  return publicFields;
}

export class FlowMailStore {
  public readonly database: MailboxDatabase;
  private listeners = new Set<(event: StoreEvent) => void>();
  private waiters = new Set<PendingWaiter>();
  private syncingInboxes = new Set<string>();
  private syncAllInFlight = false;
  private syncRateLimitUntil = 0;
  private lastInboxSyncAttemptMs = new Map<string, number>();
  public lastSyncAt: string | null = null;
  public lastSyncError: string | null = null;

  constructor(options?: { filePath?: string | null; legacyJsonPath?: string | null }) {
    const dbPath =
      options && 'filePath' in options
        ? options.filePath ?? null
        : undefined;
    this.database = new MailboxDatabase(
      dbPath !== undefined || (options && 'legacyJsonPath' in options)
        ? { dbPath, legacyJsonPath: options?.legacyJsonPath }
        : undefined,
    );
  }

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasSubscribers(): boolean {
    return this.listeners.size > 0;
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  recordActivity(
    type: ActivityEvent['type'],
    summary: string,
    inboxAddress?: string,
    detail?: string,
    status: ActivityStatus = 'info',
  ): ActivityEvent {
    const activity: ActivityEvent = {
      id: crypto.randomUUID(),
      type,
      status,
      inboxAddress,
      summary,
      detail,
      timestamp: new Date().toISOString(),
    };
    this.database.insertActivity(activity);
    this.emit({ type: 'activity', activity });
    return activity;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const inbox of this.database.listInboxes()) {
      if (inbox.expiresAt && new Date(inbox.expiresAt).getTime() <= now) {
        if (inbox.credentials) {
          void deleteLiveMxAccount(inbox.credentials);
        }
        this.database.deleteInbox(inbox.id);
      }
    }
  }

  listInboxes(): Inbox[] {
    this.pruneExpired();
    return this.database.listInboxes().map(toPublicInbox);
  }

  getInboxByIdOrAddress(idOrAddress: string): Inbox | null {
    this.pruneExpired();
    const stored = this.database.getInboxByIdOrAddress(idOrAddress);
    return stored ? toPublicInbox(stored) : null;
  }

  private generateMailboxPassword(): string {
    const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghjkmnpqrstuvwxyz';
    const digits = '23456789';
    let out = 'Rb_';
    for (let i = 0; i < 4; i++) {
      out += letters[crypto.randomInt(0, letters.length)];
      out += digits[crypto.randomInt(0, digits.length)];
      out += lower[crypto.randomInt(0, lower.length)];
      out += digits[crypto.randomInt(0, digits.length)];
    }
    return out;
  }

  private deliverInboxCredentialsEmail(
    stored: StoredInboxRecord,
    mailboxPassword: string,
  ): EmailMessage {
    const providerDesc =
      stored.provider === 'mail.tm'
        ? 'Live MX (Mail.tm)'
        : stored.provider === 'gmail-alias'
          ? 'Gmail Alias'
          : stored.provider === 'outlook-alias'
            ? 'Outlook Alias'
            : stored.provider === 'smtp'
              ? 'Local SMTP Bridge'
              : 'Webhook Inbox';

    const escapedAddr = stored.address.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedPass = mailboxPassword.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const text = [
      `สวัสดี ${stored.address},`,
      '',
      'สร้างกล่องจดหมายใหม่สำเร็จแล้ว นี่คือข้อมูลสำหรับเข้าถึงและอ้างอิงกล่องอีเมลของคุณ:',
      '',
      `อีเมล: ${stored.address}`,
      `รหัสผ่าน: ${mailboxPassword}`,
      `ประเภท: ${providerDesc}`,
      stored.expiresAt
        ? `หมดอายุ: ${new Date(stored.expiresAt).toLocaleString('th-TH')}`
        : 'อายุการใช้งาน: ถาวร (ไม่หมดอายุ)',
      '',
      'กรุณาเก็บรักษารหัสผ่านนี้ไว้เป็นความลับ',
    ].join('\n');

    const html = `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:20px;background:#0f172a;color:#e2e8f0;border-radius:12px;border:1px solid #334155;">
  <h2 style="margin:0 0 12px;font-size:18px;color:#f8fafc;">ข้อมูลอีเมลและรหัสผ่านของคุณ</h2>
  <p style="margin:0 0 16px;font-size:14px;color:#94a3b8;line-height:1.6;">
    สร้างกล่องจดหมายใหม่ใน RelayBox เรียบร้อยแล้ว สามารถดูรายละเอียดบัญชีและรหัสผ่านด้านล่าง:
  </p>
  <div style="background:#020617;border:1px solid #1e293b;border-radius:10px;padding:14px 16px;margin-bottom:16px;">
    <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">ที่อยู่อีเมล</div>
    <div style="font-family:monospace;font-size:14px;color:#93c5fd;margin-bottom:12px;word-break:break-all;">${escapedAddr}</div>
    <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">รหัสผ่านของอีเมลนี้</div>
    <div style="font-family:monospace;font-size:15px;font-weight:700;color:#34d399;word-break:break-all;">${escapedPass}</div>
  </div>
  <div style="font-size:12px;color:#94a3b8;">
    ประเภทกล่อง: <strong style="color:#e2e8f0;">${providerDesc}</strong>
  </div>
</div>`.trim();

    return this.ingestMessage({
      to: stored.address,
      from: 'security@relaybox.dev',
      fromName: 'RelayBox Mail Credentials',
      subject: `ข้อมูลอีเมลและรหัสผ่านของคุณ (${stored.address})`,
      text,
      html,
      source: 'api',
      folder: 'inbox',
    });
  }

  registerLiveMxInbox(
    provisioned: ProvisionedLiveAccount,
    options: {
      ttl?: TtlPreset;
      label?: string;
      webhookUrl?: string;
      mxVerified?: boolean | null;
      deliverCredentialsEmail?: boolean;
    } = {},
  ): Inbox {
    this.pruneExpired();
    let webhookUrl: string | undefined;
    if (options.webhookUrl && options.webhookUrl.trim()) {
      const check = validateOutboundWebhookUrl(options.webhookUrl);
      if (!check.ok) throw new Error(check.error);
      webhookUrl = check.url;
    }

    const ttl: TtlPreset = options.ttl && options.ttl in TTL_MS ? options.ttl : '24h';
    const ttlMs = TTL_MS[ttl];
    const now = Date.now();

    const stored: StoredInboxRecord = {
      id: `inb_${crypto.randomBytes(6).toString('hex')}`,
      address: provisioned.address.toLowerCase(),
      localPart: provisioned.localPart,
      domain: provisioned.domain.toLowerCase(),
      mode: 'live-mx',
      provider: 'mail.tm',
      status: 'active',
      label: (options.label || '').trim() || `Live MX (${provisioned.localPart})`,
      createdAt: new Date(now).toISOString(),
      expiresAt: ttlMs === null ? null : new Date(now + ttlMs).toISOString(),
      lastSyncedAt: new Date(now).toISOString(),
      syncError: null,
      mxVerified: options.mxVerified ?? true,
      messageCount: 0,
      unreadCount: 0,
      webhookUrl,
      credentials: {
        remoteAccountId: provisioned.remoteAccountId,
        remotePassword: provisioned.remotePassword,
        remoteToken: provisioned.remoteToken,
      },
    };

    this.database.upsertInbox(stored);
    const publicInbox = toPublicInbox(stored);
    this.recordActivity(
      'inbox:created',
      `Provisioned live MX address ${stored.address}`,
      stored.address,
      `Provider: mail.tm`,
      'success',
    );
    this.emit({
      type: 'inbox:created',
      inboxId: stored.id,
      inboxAddress: stored.address,
      inbox: publicInbox,
    });
    if (options.deliverCredentialsEmail && provisioned.remotePassword) {
      this.deliverInboxCredentialsEmail(stored, provisioned.remotePassword);
      return this.getInboxByIdOrAddress(stored.id) ?? publicInbox;
    }
    return publicInbox;
  }

  createInbox(
    input: CreateWebhookInboxInput & { mode?: InboxMode; deliverCredentialsEmail?: boolean } = {},
  ): Inbox {
    this.pruneExpired();
    const domainInput = (input.domain || WEBHOOK_DOMAINS[0]).trim().toLowerCase();
    if (!isWebhookDomain(domainInput)) {
      throw new Error(
        `Unsupported webhook domain "${domainInput}". Allowed: ${WEBHOOK_DOMAINS.join(', ')}`,
      );
    }

    let localPart = (input.prefix || '').trim().toLowerCase();
    if (!localPart) {
      localPart = generateRandomLocalPart('inbox');
    } else {
      localPart = localPart.replace(/[^a-z0-9._+-]/g, '');
      if (!localPart || localPart.length > 64) {
        throw new Error(
          'Invalid local address prefix. Use 1–64 alphanumeric, dot, dash, or underscore characters.',
        );
      }
    }

    let address = `${localPart}@${domainInput}`;
    const existing = this.database.getInboxByIdOrAddress(address);
    if (existing && !input.prefix) {
      localPart = generateRandomLocalPart('inbox');
      address = `${localPart}@${domainInput}`;
    } else if (existing) {
      throw new Error(`Address "${address}" already exists.`);
    }

    let webhookUrl: string | undefined;
    if (input.webhookUrl && input.webhookUrl.trim()) {
      const check = validateOutboundWebhookUrl(input.webhookUrl);
      if (!check.ok) throw new Error(check.error);
      webhookUrl = check.url;
    }

    const ttl: TtlPreset = input.ttl && input.ttl in TTL_MS ? input.ttl : '24h';
    const ttlMs = TTL_MS[ttl];
    const now = Date.now();
    const provider: InboxProvider = input.provider === 'smtp' ? 'smtp' : 'webhook';

    const stored: StoredInboxRecord = {
      id: `inb_${crypto.randomBytes(6).toString('hex')}`,
      address,
      localPart,
      domain: domainInput,
      mode: 'webhook',
      provider,
      status: 'active',
      label: (input.label || '').trim() || `Webhook / SMTP (${localPart})`,
      createdAt: new Date(now).toISOString(),
      expiresAt: ttlMs === null ? null : new Date(now + ttlMs).toISOString(),
      lastSyncedAt: null,
      syncError: null,
      mxVerified: null,
      messageCount: 0,
      unreadCount: 0,
      webhookUrl,
    };

    this.database.upsertInbox(stored);
    const publicInbox = toPublicInbox(stored);
    this.recordActivity(
      'inbox:created',
      `Created ${provider.toUpperCase()} inbox ${stored.address}`,
      stored.address,
      `Provider: ${provider}`,
      'success',
    );
    this.emit({
      type: 'inbox:created',
      inboxId: stored.id,
      inboxAddress: stored.address,
      inbox: publicInbox,
    });
    if (input.deliverCredentialsEmail) {
      const mailboxPassword = this.generateMailboxPassword();
      this.deliverInboxCredentialsEmail(stored, mailboxPassword);
      return this.getInboxByIdOrAddress(stored.id) ?? publicInbox;
    }
    return publicInbox;
  }

  createAliasInbox(input: {
    baseEmail?: string;
    domain?: string;
    provider?: 'gmail-alias' | 'outlook-alias';
    strategy?: 'plus' | 'dot';
    tag?: string;
    ttl?: TtlPreset;
    label?: string;
    webhookUrl?: string;
    deliverCredentialsEmail?: boolean;
  }): Inbox {
    this.pruneExpired();
    const rawBaseInput = (input.baseEmail || '').trim();
    const parsed = rawBaseInput ? normalizeEmailAddress(rawBaseInput) : null;
    if (rawBaseInput && !parsed) {
      throw new Error('รูปแบบอีเมลหลักไม่ถูกต้อง (เช่น name@gmail.com หรือ name@outlook.com)');
    }

    const requestedDomain = (input.domain || '').trim().toLowerCase();
    const domain = parsed
      ? parsed.domain.toLowerCase()
      : input.provider === 'outlook-alias'
        ? (OUTLOOK_ALIAS_DOMAINS as readonly string[]).includes(requestedDomain)
          ? requestedDomain
          : 'outlook.com'
        : (GMAIL_ALIAS_DOMAINS as readonly string[]).includes(requestedDomain)
          ? requestedDomain
          : 'gmail.com';

    const isOutlookDomain = (OUTLOOK_ALIAS_DOMAINS as readonly string[]).includes(domain);
    const isGmailDomain = (GMAIL_ALIAS_DOMAINS as readonly string[]).includes(domain);

    const provider: 'gmail-alias' | 'outlook-alias' =
      input.provider === 'outlook-alias'
        ? 'outlook-alias'
        : input.provider === 'gmail-alias'
          ? 'gmail-alias'
          : isOutlookDomain
            ? 'outlook-alias'
            : 'gmail-alias';

    if (provider === 'outlook-alias' && !isOutlookDomain) {
      throw new Error(
        `อีเมล Outlook Alias ต้องใช้โดเมน ${OUTLOOK_ALIAS_DOMAINS.join(', ')}`,
      );
    }
    if (provider === 'gmail-alias' && isOutlookDomain) {
      throw new Error('อีเมลนี้เป็นโดเมน Outlook/Hotmail กรุณาเลือกโหมด Outlook Alias');
    }

    const hasExplicitBase = Boolean(parsed);
    const rawBaseLocal = parsed
      ? parsed.localPart.split('+')[0].trim().toLowerCase()
      : `rb${crypto.randomBytes(3).toString('hex')}`;

    if (!rawBaseLocal || rawBaseLocal.length > 48) {
      throw new Error('ชื่อบัญชีอีเมลหลักไม่ถูกต้อง');
    }

    const strategy: 'plus' | 'dot' =
      provider === 'gmail-alias' && input.strategy === 'dot' ? 'dot' : 'plus';

    let localPart = '';
    if (strategy === 'dot' && isGmailDomain) {
      const undotted = rawBaseLocal.replace(/\./g, '');
      if (undotted.length < 2) {
        throw new Error('ชื่อบัญชี Gmail สั้นเกินไปสำหรับการแทรกจุด (.)');
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        const chars = undotted.split('');
        let candidate = '';
        let dotsPlaced = 0;
        for (let i = 0; i < chars.length; i++) {
          candidate += chars[i];
          if (i < chars.length - 1 && (attempt === 0 ? i === 0 : crypto.randomInt(0, 100) < 40)) {
            candidate += '.';
            dotsPlaced += 1;
          }
        }
        if (dotsPlaced === 0) {
          candidate = `${chars[0]}.${chars.slice(1).join('')}`;
        }
        if (!this.database.getInboxByIdOrAddress(`${candidate}@${domain}`)) {
          localPart = candidate;
          break;
        }
      }
      if (!localPart) {
        const fallbackTag = `rb${crypto.randomBytes(2).toString('hex')}`;
        localPart = `${undotted}+${fallbackTag}`;
      }
    } else {
      const customTag = (input.tag || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 24);
      if (hasExplicitBase) {
        const tag = customTag || `rb${crypto.randomBytes(2).toString('hex')}`;
        localPart = `${rawBaseLocal}+${tag}`;
        if (this.database.getInboxByIdOrAddress(`${localPart}@${domain}`)) {
          if (customTag) {
            throw new Error(`ที่อยู่ "${localPart}@${domain}" มีอยู่ในระบบแล้ว`);
          }
          localPart = `${rawBaseLocal}+rb${crypto.randomBytes(3).toString('hex')}`;
        }
      } else {
        localPart = customTag ? `${rawBaseLocal}+${customTag}` : rawBaseLocal;
        if (this.database.getInboxByIdOrAddress(`${localPart}@${domain}`)) {
          const freshLocal = `rb${crypto.randomBytes(4).toString('hex')}`;
          localPart = customTag ? `${freshLocal}+${customTag}` : freshLocal;
        }
      }
    }

    const address = `${localPart}@${domain}`;
    if (this.database.getInboxByIdOrAddress(address)) {
      throw new Error(`ที่อยู่ "${address}" มีอยู่ในระบบแล้ว`);
    }

    let webhookUrl: string | undefined;
    if (input.webhookUrl && input.webhookUrl.trim()) {
      const check = validateOutboundWebhookUrl(input.webhookUrl);
      if (!check.ok) throw new Error(check.error);
      webhookUrl = check.url;
    }

    const ttl: TtlPreset = input.ttl && input.ttl in TTL_MS ? input.ttl : 'never';
    const ttlMs = TTL_MS[ttl];
    const now = Date.now();
    const defaultLabel =
      provider === 'outlook-alias'
        ? `Outlook Alias (${localPart.includes('+') ? '+' + localPart.split('+')[1] : localPart})`
        : `Gmail Alias (${localPart.includes('+') ? '+' + localPart.split('+')[1] : 'Dot'})`;

    const stored: StoredInboxRecord = {
      id: `inb_${crypto.randomBytes(6).toString('hex')}`,
      address,
      localPart,
      domain,
      mode: 'alias',
      provider,
      status: 'active',
      label: (input.label || '').trim() || defaultLabel,
      createdAt: new Date(now).toISOString(),
      expiresAt: ttlMs === null ? null : new Date(now + ttlMs).toISOString(),
      lastSyncedAt: null,
      syncError: null,
      mxVerified: true,
      messageCount: 0,
      unreadCount: 0,
      webhookUrl,
    };

    this.database.upsertInbox(stored);
    const publicInbox = toPublicInbox(stored);
    this.recordActivity(
      'inbox:created',
      `Created ${provider === 'outlook-alias' ? 'Outlook' : 'Gmail'} alias ${stored.address}`,
      stored.address,
      parsed ? `Base account: ${parsed.full}` : 'Generated alias (optional base account)',
      'success',
    );
    this.emit({
      type: 'inbox:created',
      inboxId: stored.id,
      inboxAddress: stored.address,
      inbox: publicInbox,
    });
    if (input.deliverCredentialsEmail) {
      const mailboxPassword = this.generateMailboxPassword();
      this.deliverInboxCredentialsEmail(stored, mailboxPassword);
      return this.getInboxByIdOrAddress(stored.id) ?? publicInbox;
    }
    return publicInbox;
  }

  markInboxSynced(idOrAddress: string, addedCount = 0): Inbox | null {
    const stored = this.database.getInboxByIdOrAddress(idOrAddress);
    if (!stored) return null;
    stored.lastSyncedAt = new Date().toISOString();
    stored.syncError = null;
    stored.status = 'active';
    this.database.upsertInbox(stored);
    const publicInbox = this.getInboxByIdOrAddress(stored.id) ?? toPublicInbox(stored);
    if (addedCount > 0) {
      this.recordActivity(
        'inbox:synced',
        `Synced ${addedCount} real message(s) for ${stored.address}`,
        stored.address,
        undefined,
        'success',
      );
    }
    this.emit({
      type: 'inbox:synced',
      inboxId: stored.id,
      inboxAddress: stored.address,
      inbox: publicInbox,
    });
    return publicInbox;
  }

  updateInbox(
    idOrAddress: string,
    patch: {
      label?: string;
      status?: InboxStatus;
      webhookUrl?: string | null;
      ttl?: TtlPreset;
      mxVerified?: boolean | null;
    },
  ): Inbox | null {
    const stored = this.database.getInboxByIdOrAddress(idOrAddress);
    if (!stored) return null;

    if (typeof patch.label === 'string' && patch.label.trim()) {
      stored.label = patch.label.trim().slice(0, 80);
    }
    if (patch.status && ['active', 'paused', 'error', 'expired'].includes(patch.status)) {
      stored.status = patch.status;
    }
    if (patch.webhookUrl !== undefined) {
      if (!patch.webhookUrl || !patch.webhookUrl.trim()) {
        stored.webhookUrl = undefined;
      } else {
        const check = validateOutboundWebhookUrl(patch.webhookUrl);
        if (!check.ok) throw new Error(check.error);
        stored.webhookUrl = check.url;
      }
    }
    if (patch.ttl && patch.ttl in TTL_MS) {
      const ttlMs = TTL_MS[patch.ttl];
      stored.expiresAt = ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString();
    }
    if (patch.mxVerified !== undefined) {
      stored.mxVerified = patch.mxVerified;
    }

    this.database.upsertInbox(stored);
    const publicInbox = toPublicInbox(stored);
    this.recordActivity(
      'inbox:updated',
      `Updated mailbox settings for ${stored.address}`,
      stored.address,
      `Status: ${stored.status}`,
      'info',
    );
    this.emit({
      type: 'inbox:updated',
      inboxId: stored.id,
      inboxAddress: stored.address,
      inbox: publicInbox,
    });
    return publicInbox;
  }

  deleteInbox(idOrAddress: string): boolean {
    const stored = this.database.getInboxByIdOrAddress(idOrAddress);
    if (!stored) return false;
    if (stored.credentials) {
      void deleteLiveMxAccount(stored.credentials);
    }
    this.database.deleteInbox(stored.id);
    this.recordActivity(
      'inbox:deleted',
      `Deleted inbox ${stored.address}`,
      stored.address,
      undefined,
      'warning',
    );
    this.emit({ type: 'inbox:deleted', inboxId: stored.id, inboxAddress: stored.address });
    return true;
  }

  clearInboxMessages(idOrAddress: string): number {
    const stored = this.database.getInboxByIdOrAddress(idOrAddress);
    if (!stored) return 0;
    const msgs = this.database.queryMessages({ inboxId: stored.id, folder: 'all', limit: 500 }).messages;
    for (const msg of msgs) {
      if (msg.remoteId && stored.credentials) {
        void deleteLiveMxMessage(msg.remoteId, stored.credentials);
      }
    }
    const deleted = this.database.clearInboxMessages(stored.id);
    const updatedInbox = this.getInboxByIdOrAddress(stored.id);
    this.emit({
      type: 'inbox:cleared',
      inboxId: stored.id,
      inboxAddress: stored.address,
      inbox: updatedInbox ?? undefined,
    });
    return deleted;
  }

  updateInboxWebhook(idOrAddress: string, rawUrl: string | null): Inbox | null {
    return this.updateInbox(idOrAddress, { webhookUrl: rawUrl });
  }

  async syncLiveInbox(
    idOrAddress: string,
    options?: { force?: boolean },
  ): Promise<{ inbox: Inbox; added: EmailMessage[] }> {
    const stored = this.database.getInboxByIdOrAddress(idOrAddress);
    if (!stored) {
      throw new Error(`Inbox "${idOrAddress}" not found.`);
    }
    if (stored.mode !== 'live-mx' || !stored.credentials || stored.status === 'paused') {
      return { inbox: toPublicInbox(stored), added: [] };
    }
    if (this.syncingInboxes.has(stored.id)) {
      return { inbox: toPublicInbox(stored), added: [] };
    }

    const now = Date.now();
    if (now < this.syncRateLimitUntil) {
      const waitSec = Math.max(1, Math.ceil((this.syncRateLimitUntil - now) / 1000));
      if (options?.force) {
        throw new MailTmRateLimitError(
          waitSec,
          `ผู้ให้บริการ Live MX จำกัดความถี่ชั่วคราว กรุณารออีก ${waitSec} วินาทีแล้วลองเช็คเมลอีกครั้ง`,
        );
      }
      return { inbox: toPublicInbox(stored), added: [] };
    }

    const lastAttempt = this.lastInboxSyncAttemptMs.get(stored.id) ?? 0;
    if (!options?.force && now - lastAttempt < 6000) {
      return { inbox: toPublicInbox(stored), added: [] };
    }

    this.syncingInboxes.add(stored.id);
    this.lastInboxSyncAttemptMs.set(stored.id, now);
    try {
      const knownRemoteIds = this.database.listKnownRemoteIds(stored.id);
      const mxCheck = await checkDomainMxRecords(stored.domain).catch(() => null);
      if (mxCheck) {
        stored.mxVerified = mxCheck.mxVerified;
      }

      const { messages: payloads, refreshedToken } = await fetchNewLiveMxMessages(
        stored.address,
        stored.credentials,
        knownRemoteIds,
      );

      if (refreshedToken) {
        stored.credentials.remoteToken = refreshedToken;
      }
      stored.lastSyncedAt = new Date().toISOString();
      stored.syncError = null;
      stored.status = 'active';
      this.database.upsertInbox(stored);

      const added: EmailMessage[] = [];
      for (const payload of payloads) {
        const msg = this.ingestMessage(payload);
        added.push(msg);
      }

      this.lastSyncAt = stored.lastSyncedAt;
      this.lastSyncError = null;

      const publicInbox = this.getInboxByIdOrAddress(stored.id) ?? toPublicInbox(stored);
      if (added.length > 0) {
        this.recordActivity(
          'inbox:synced',
          `Synced ${added.length} new message(s) for ${stored.address}`,
          stored.address,
          undefined,
          'success',
        );
      }
      this.emit({
        type: 'inbox:synced',
        inboxId: stored.id,
        inboxAddress: stored.address,
        inbox: publicInbox,
      });
      return { inbox: publicInbox, added };
    } catch (err) {
      if (err instanceof MailTmRateLimitError) {
        this.syncRateLimitUntil = Date.now() + err.retryAfterSec * 1000;
        const msg = `ผู้ให้บริการ Live MX จำกัดความถี่ชั่วคราว (429) — จะซิงก์ใหม่อัตโนมัติใน ${err.retryAfterSec} วินาที`;
        stored.syncError = msg;
        stored.status = 'active';
        this.database.upsertInbox(stored);
        this.lastSyncError = msg;
        const publicInbox = this.getInboxByIdOrAddress(stored.id) ?? toPublicInbox(stored);
        this.emit({
          type: 'inbox:synced',
          inboxId: stored.id,
          inboxAddress: stored.address,
          inbox: publicInbox,
        });
        throw new MailTmRateLimitError(err.retryAfterSec, msg);
      }

      const msg = err instanceof Error ? err.message : 'Sync failed';
      stored.syncError = msg;
      stored.status = 'error';
      this.database.upsertInbox(stored);
      this.lastSyncError = msg;
      this.recordActivity('inbox:synced', `Sync failed for ${stored.address}`, stored.address, msg, 'error');
      const publicInbox = this.getInboxByIdOrAddress(stored.id) ?? toPublicInbox(stored);
      this.emit({
        type: 'inbox:synced',
        inboxId: stored.id,
        inboxAddress: stored.address,
        inbox: publicInbox,
      });
      throw err;
    } finally {
      this.syncingInboxes.delete(stored.id);
    }
  }

  async syncAllLiveInboxes(): Promise<void> {
    if (this.syncAllInFlight) return;
    if (Date.now() < this.syncRateLimitUntil) return;

    this.syncAllInFlight = true;
    try {
      this.pruneExpired();
      const liveInboxes = this.database
        .listInboxes()
        .filter((i) => i.mode === 'live-mx' && Boolean(i.credentials) && i.status !== 'paused');

      for (let i = 0; i < liveInboxes.length; i++) {
        if (Date.now() < this.syncRateLimitUntil) {
          break;
        }
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 450));
          if (Date.now() < this.syncRateLimitUntil) {
            break;
          }
        }
        await this.syncLiveInbox(liveInboxes[i].id).catch(() => undefined);
      }
    } finally {
      this.syncAllInFlight = false;
    }
  }

  ingestMessage(payload: IngestEmailPayload): EmailMessage {
    this.pruneExpired();
    const parsedTo = normalizeEmailAddress(payload.to);
    if (!parsedTo) {
      throw new Error('Invalid recipient "to" email address.');
    }

    let inbox = this.database.getInboxByIdOrAddress(parsedTo.full);
    if (!inbox) {
      if (payload.autoCreateInbox) {
        if (!isWebhookDomain(parsedTo.domain)) {
          throw new Error(
            `Cannot auto-create webhook inbox for domain "${parsedTo.domain}".`,
          );
        }
        const created = this.createInbox({
          prefix: parsedTo.localPart,
          domain: parsedTo.domain,
          ttl: '24h',
          label: `Inbound (${parsedTo.localPart})`,
          provider: payload.source === 'smtp' ? 'smtp' : 'webhook',
        });
        inbox = this.database.getInboxByIdOrAddress(created.id);
      }
      if (!inbox) {
        throw new Error(
          `Inbox "${parsedTo.full}" does not exist. Create it first or set autoCreateInbox: true.`,
        );
      }
    }

    const fromInput = (payload.from || 'noreply@sender.local').trim();
    const parsedFrom = normalizeEmailAddress(fromInput);
    const fromAddr = parsedFrom ? parsedFrom.full : fromInput;
    const fromName = payload.fromName?.trim() || parsedFrom?.displayName || undefined;

    const subject = (payload.subject || '').trim() || '(No Subject)';
    const html = typeof payload.html === 'string' ? payload.html : '';
    const text =
      typeof payload.text === 'string' && payload.text.trim()
        ? payload.text
        : stripHtmlToText(html);

    const contentHash = computeMessageContentHash(inbox.id, fromAddr, subject, text);
    const duplicate = this.database.findDuplicateMessage(inbox.id, payload.remoteId, contentHash);
    if (duplicate) {
      return duplicate;
    }

    const safeAttachments: EmailAttachment[] = [];
    for (const rawAtt of Array.isArray(payload.attachments) ? payload.attachments : []) {
      const check = validateAttachment(rawAtt);
      if (!check.ok) {
        throw new Error(check.reason);
      }
      safeAttachments.push(check.sanitized);
    }

    const extracted = extractArtifacts(text, html);
    const spamCheck = classifySpam({
      from: fromAddr,
      subject,
      text,
      html,
      headers: payload.headers,
      attachments: safeAttachments,
    });

    const folder: MessageFolder =
      payload.folder ?? (spamCheck.isSpam ? 'spam' : 'inbox');

    const nowIso = payload.receivedAt || new Date().toISOString();
    const msgId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    const threadId = computeThreadId(subject, payload.headers);

    const message: EmailMessage = {
      id: msgId,
      remoteId: payload.remoteId,
      inboxId: inbox.id,
      to: inbox.address,
      from: fromAddr,
      fromName,
      subject,
      text,
      html:
        html ||
        `<pre style="font-family:monospace;white-space:pre-wrap;">${text.replace(/</g, '&lt;')}</pre>`,
      snippet: buildSnippet(text, html),
      headers: {
        'Delivered-To': inbox.address,
        From: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
        To: inbox.address,
        Subject: subject,
        Date: new Date(nowIso).toUTCString(),
        'Message-ID': `<${msgId}@${inbox.domain}>`,
        ...(payload.headers ?? {}),
      },
      attachments: safeAttachments,
      extracted,
      folder,
      threadId,
      contentHash,
      spamScore: spamCheck.score,
      spamReasons: spamCheck.reasons,
      read: folder === 'sent' || folder === 'drafts',
      starred: false,
      source: payload.source ?? 'api',
      receivedAt: nowIso,
      deletedAt: null,
    };

    this.database.insertMessage(message);

    if (folder === 'inbox' || folder === 'spam') {
      const maskedDetail = extracted.primaryOtp
        ? `OTP detected (${redactOtpCode(extracted.primaryOtp)})`
        : extracted.primaryActionUrl
          ? `Verification link: ${redactSensitiveUrl(extracted.primaryActionUrl)}`
          : folder === 'spam'
            ? `Classified as Spam (score ${spamCheck.score})`
            : undefined;

      this.recordActivity(
        'email:received',
        `${subject} -> ${inbox.address}`,
        inbox.address,
        maskedDetail,
        folder === 'spam' ? 'warning' : 'success',
      );

      if (extracted.otpCodes.length > 0) {
        this.recordActivity(
          'otp:detected',
          `Detected ${extracted.otpCodes.length} verification code(s) in "${subject}"`,
          inbox.address,
          `Masked code: ${redactOtpCode(extracted.otpCodes[0])}`,
          'success',
        );
      }
    }

    const updatedInbox = this.getInboxByIdOrAddress(inbox.id) ?? toPublicInbox(inbox);
    this.emit({
      type: 'email:received',
      inboxId: inbox.id,
      inboxAddress: inbox.address,
      inbox: updatedInbox,
      message,
    });

    if (folder === 'inbox') {
      this.resolveWaiters(message);
    }
    return message;
  }

  saveDraftOrSentMessage(input: {
    inboxIdOrAddress: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    mode: 'drafts' | 'sent';
  }): EmailMessage {
    const senderInbox = this.database.getInboxByIdOrAddress(input.inboxIdOrAddress);
    if (!senderInbox) throw new Error('Sender inbox not found.');

    const parsedRecipient = normalizeEmailAddress(input.to);
    if (!parsedRecipient && input.mode === 'sent') {
      throw new Error('Valid recipient email address is required to send.');
    }

    const nowIso = new Date().toISOString();
    const msgId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    const text = input.text || '';
    const html =
      input.html ||
      `<pre style="font-family:monospace;white-space:pre-wrap;">${text.replace(/</g, '&lt;')}</pre>`;
    const subject = input.subject.trim() || '(No Subject)';

    const message: EmailMessage = {
      id: msgId,
      inboxId: senderInbox.id,
      to: parsedRecipient ? parsedRecipient.full : input.to.trim(),
      from: senderInbox.address,
      fromName: senderInbox.label,
      subject,
      text,
      html,
      snippet: buildSnippet(text, html),
      headers: {
        From: senderInbox.address,
        To: parsedRecipient ? parsedRecipient.full : input.to.trim(),
        Subject: subject,
        Date: new Date(nowIso).toUTCString(),
        'Message-ID': `<${msgId}@${senderInbox.domain}>`,
      },
      attachments: [],
      extracted: extractArtifacts(text, html),
      folder: input.mode,
      threadId: computeThreadId(subject),
      contentHash: computeMessageContentHash(senderInbox.id, senderInbox.address, subject, text),
      spamScore: 0,
      spamReasons: [],
      read: true,
      starred: false,
      source: 'outbound',
      receivedAt: nowIso,
      deletedAt: null,
    };

    this.database.insertMessage(message);

    if (input.mode === 'sent') {
      this.recordActivity(
        'email:sent',
        `Sent message "${subject}" to ${message.to}`,
        senderInbox.address,
        undefined,
        'success',
      );
      // If recipient is a local inbox on this RelayBox instance, deliver internally!
      if (parsedRecipient && this.database.getInboxByIdOrAddress(parsedRecipient.full)) {
        this.ingestMessage({
          to: parsedRecipient.full,
          from: senderInbox.address,
          fromName: senderInbox.label,
          subject,
          text,
          html,
          source: 'api',
        });
      }
    }

    const updatedInbox = this.getInboxByIdOrAddress(senderInbox.id) ?? toPublicInbox(senderInbox);
    this.emit({
      type: 'email:received',
      inboxId: senderInbox.id,
      inboxAddress: senderInbox.address,
      inbox: updatedInbox,
      message,
    });
    return message;
  }

  listMessages(idOrAddress: string, filters: MessageFilterOptions = {}): EmailMessage[] {
    const inbox = this.database.getInboxByIdOrAddress(idOrAddress);
    if (!inbox) return [];
    return this.database.queryMessages({
      inboxId: inbox.id,
      folder: filters.folder,
      subject: filters.subject,
      from: filters.from,
      unreadOnly: filters.unreadOnly,
      starredOnly: filters.starredOnly,
      hasOtp: filters.hasOtp,
      query: filters.query,
      limit: filters.limit,
      offset: filters.offset,
    }).messages;
  }

  queryMessagesPaginated(params: MessageQueryParams): { messages: EmailMessage[]; total: number } {
    return this.database.queryMessages(params);
  }

  getLatestMessage(idOrAddress: string, filters: MessageFilterOptions = {}): EmailMessage | null {
    const list = this.listMessages(idOrAddress, { ...filters, limit: 1 });
    return list[0] ?? null;
  }

  getMessage(messageId: string): EmailMessage | null {
    return this.database.getMessage(messageId);
  }

  updateMessage(
    messageId: string,
    patch: { read?: boolean; starred?: boolean; folder?: MessageFolder },
  ): EmailMessage | null {
    const prev = this.database.getMessage(messageId);
    if (!prev) return null;
    const deletedAt =
      patch.folder === 'trash'
        ? new Date().toISOString()
        : patch.folder
          ? null
          : prev.deletedAt;

    const updated = this.database.updateMessage(messageId, { ...patch, deletedAt });
    if (!updated) return null;

    const inbox = this.getInboxByIdOrAddress(updated.inboxId);
    if (!prev.read && updated.read) {
      this.recordActivity(
        'email:read',
        `Marked read: "${updated.subject}"`,
        inbox?.address,
        undefined,
        'info',
      );
    }

    this.emit({
      type: 'message:updated',
      inboxId: updated.inboxId,
      inboxAddress: inbox?.address,
      inbox: inbox ?? undefined,
      message: updated,
    });
    return updated;
  }

  deleteMessage(messageId: string, permanent = false): boolean {
    const msg = this.database.getMessage(messageId);
    if (!msg) return false;
    const storedInbox = this.database.getInboxByIdOrAddress(msg.inboxId);

    // Move to Trash first unless permanent delete requested or already in Trash
    if (!permanent && msg.folder !== 'trash') {
      this.updateMessage(messageId, { folder: 'trash' });
      return true;
    }

    if (msg.remoteId && storedInbox?.credentials) {
      void deleteLiveMxMessage(msg.remoteId, storedInbox.credentials);
    }
    this.database.deleteMessage(messageId);
    const updatedInbox = storedInbox ? this.getInboxByIdOrAddress(storedInbox.id) : null;
    this.emit({
      type: 'message:deleted',
      inboxId: msg.inboxId,
      inboxAddress: updatedInbox?.address,
      inbox: updatedInbox ?? undefined,
      messageId,
    });
    return true;
  }

  bulkActionMessages(
    messageIds: string[],
    action: 'markRead' | 'markUnread' | 'star' | 'unstar' | 'delete' | 'restore',
    options: { permanent?: boolean } = {},
  ): { affected: number; updated: EmailMessage[]; deletedIds: string[] } {
    const uniqueIds = [...new Set(messageIds.filter((id) => typeof id === 'string' && id.trim().length > 0))].slice(
      0,
      500,
    );
    const updated: EmailMessage[] = [];
    const deletedIds: string[] = [];
    let affected = 0;

    for (const id of uniqueIds) {
      if (action === 'markRead') {
        const res = this.updateMessage(id, { read: true });
        if (res) {
          updated.push(res);
          affected += 1;
        }
      } else if (action === 'markUnread') {
        const res = this.updateMessage(id, { read: false });
        if (res) {
          updated.push(res);
          affected += 1;
        }
      } else if (action === 'star') {
        const res = this.updateMessage(id, { starred: true });
        if (res) {
          updated.push(res);
          affected += 1;
        }
      } else if (action === 'unstar') {
        const res = this.updateMessage(id, { starred: false });
        if (res) {
          updated.push(res);
          affected += 1;
        }
      } else if (action === 'restore') {
        const res = this.updateMessage(id, { folder: 'inbox' });
        if (res) {
          updated.push(res);
          affected += 1;
        }
      } else if (action === 'delete') {
        const prev = this.database.getMessage(id);
        if (!prev) continue;
        const shouldRemove = Boolean(options.permanent) || prev.folder === 'trash';
        if (shouldRemove) {
          if (this.deleteMessage(id, true)) {
            deletedIds.push(id);
            affected += 1;
          }
        } else {
          const moved = this.updateMessage(id, { folder: 'trash' });
          if (moved) {
            updated.push(moved);
            affected += 1;
          }
        }
      }
    }

    return { affected, updated, deletedIds };
  }

  listOtpEntries(options: {
    inboxId?: string;
    query?: string;
    kind?: 'all' | 'otp' | 'links';
    limit?: number;
  } = {}): OtpEntry[] {
    const inboxes = new Map(this.listInboxes().map((i) => [i.id, i.address]));
    const { messages } = this.database.queryMessages({
      inboxId: options.inboxId || undefined,
      folder: 'all',
      query: options.query,
      limit: options.limit ?? 100,
    });

    const entries: OtpEntry[] = [];
    for (const msg of messages) {
      if (msg.folder === 'trash') continue;
      const hasOtp = msg.extracted.otpCodes.length > 0;
      const hasLinks = msg.extracted.links.length > 0;
      if (!hasOtp && !hasLinks) continue;
      if (options.kind === 'otp' && !hasOtp) continue;
      if (options.kind === 'links' && !hasLinks) continue;
      entries.push({
        messageId: msg.id,
        inboxId: msg.inboxId,
        inboxAddress: inboxes.get(msg.inboxId) || msg.to,
        from: msg.from,
        fromName: msg.fromName,
        subject: msg.subject,
        otpCodes: msg.extracted.otpCodes,
        links: msg.extracted.links,
        receivedAt: msg.receivedAt,
      });
    }
    return entries;
  }

  private matchesWaiterFilter(
    msg: EmailMessage,
    filter: { subject?: string; from?: string },
  ): boolean {
    if (filter.subject && !msg.subject.toLowerCase().includes(filter.subject.toLowerCase())) {
      return false;
    }
    if (filter.from && !msg.from.toLowerCase().includes(filter.from.toLowerCase())) {
      return false;
    }
    return true;
  }

  private resolveWaiters(message: EmailMessage): void {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.inboxId !== message.inboxId) continue;
      if (
        this.matchesWaiterFilter(message, {
          subject: waiter.subject,
          from: waiter.from,
        })
      ) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        const inbox = this.getInboxByIdOrAddress(message.inboxId);
        this.recordActivity(
          'wait:matched',
          `API wait matched "${message.subject}"`,
          inbox?.address,
          undefined,
          'success',
        );
        waiter.resolve(message);
      }
    }
  }

  async waitForMessage(idOrAddress: string, options: WaitOptions = {}): Promise<EmailMessage | null> {
    const inbox = this.database.getInboxByIdOrAddress(idOrAddress);
    if (!inbox) {
      throw new Error(`Inbox "${idOrAddress}" not found.`);
    }

    if (inbox.mode === 'live-mx') {
      await this.syncLiveInbox(inbox.id).catch(() => undefined);
    }

    const sinceMs = options.since ? new Date(options.since).getTime() : 0;
    const existing = this.listMessages(inbox.id, {
      folder: 'inbox',
      subject: options.subject,
      from: options.from,
    }).find((msg) => new Date(msg.receivedAt).getTime() >= sinceMs);

    if (existing) {
      this.recordActivity(
        'wait:matched',
        `API wait matched "${existing.subject}"`,
        inbox.address,
        undefined,
        'success',
      );
      return existing;
    }

    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15000, 100), 60000);
    return new Promise<EmailMessage | null>((resolve) => {
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (pollInterval) clearInterval(pollInterval);
      };

      const waiter: PendingWaiter = {
        inboxId: inbox.id,
        subject: options.subject,
        from: options.from,
        resolve: (msg) => {
          cleanup();
          resolve(msg);
        },
        timer: setTimeout(() => {
          cleanup();
          this.waiters.delete(waiter);
          this.recordActivity(
            'wait:timeout',
            `API wait timed out after ${timeoutMs}ms`,
            inbox.address,
            undefined,
            'warning',
          );
          resolve(null);
        }, timeoutMs),
      };

      this.waiters.add(waiter);

      if (inbox.mode === 'live-mx') {
        pollInterval = setInterval(() => {
          void this.syncLiveInbox(inbox.id);
        }, 2500);
      }
    });
  }

  createApiKey(
    name: string,
    scopes: ApiKeyScope[] = ['read', 'write', 'webhooks', 'admin'],
    rateLimitPerMin = 120,
  ): { summary: ApiKeySummary; plaintextKey: string } {
    const cleanName = name.trim() || 'CI Automation Key';
    const validScopes: ApiKeyScope[] = scopes.filter((s) =>
      ['read', 'write', 'webhooks', 'admin'].includes(s),
    );
    const finalScopes: ApiKeyScope[] =
      validScopes.length > 0 ? Array.from(new Set(validScopes)) : ['read'];
    const clampedRate = Math.min(Math.max(Number(rateLimitPerMin) || 120, 10), 2000);

    const rawSecret = crypto.randomBytes(20).toString('hex');
    const plaintextKey = `fm_live_${rawSecret}`;
    const stored = {
      id: `key_${crypto.randomBytes(6).toString('hex')}`,
      name: cleanName,
      prefix: `${plaintextKey.slice(0, 14)}…`,
      keyHash: hashKey(plaintextKey),
      scopes: finalScopes,
      rateLimitPerMin: clampedRate,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };

    this.database.insertApiKey(stored);
    this.recordActivity(
      'key:created',
      `Generated API key "${cleanName}" (${stored.prefix})`,
      undefined,
      `Scopes: ${finalScopes.join(', ')}`,
      'success',
    );
    return {
      plaintextKey,
      summary: {
        id: stored.id,
        name: stored.name,
        prefix: stored.prefix,
        scopes: stored.scopes,
        rateLimitPerMin: stored.rateLimitPerMin,
        createdAt: stored.createdAt,
        lastUsedAt: stored.lastUsedAt,
      },
    };
  }

  listApiKeys(): ApiKeySummary[] {
    return this.database.listApiKeys().map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      rateLimitPerMin: k.rateLimitPerMin,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    }));
  }

  verifyApiKey(plaintext: string): ApiKeySummary | null {
    if (!plaintext) return null;
    const candidateBuf = Buffer.from(hashKey(plaintext), 'hex');
    for (const stored of this.database.listApiKeys()) {
      const storedBuf = Buffer.from(stored.keyHash, 'hex');
      if (
        candidateBuf.length === storedBuf.length &&
        crypto.timingSafeEqual(candidateBuf, storedBuf)
      ) {
        const nowIso = new Date().toISOString();
        this.database.touchApiKeyUsed(stored.id, nowIso);
        return {
          id: stored.id,
          name: stored.name,
          prefix: stored.prefix,
          scopes: stored.scopes,
          rateLimitPerMin: stored.rateLimitPerMin,
          createdAt: stored.createdAt,
          lastUsedAt: nowIso,
        };
      }
    }
    return null;
  }

  revokeApiKey(id: string): boolean {
    const key = this.database.listApiKeys().find((k) => k.id === id);
    if (!key) return false;
    this.database.deleteApiKey(id);
    this.recordActivity(
      'key:revoked',
      `Revoked API key "${key.name}" (${key.prefix})`,
      undefined,
      undefined,
      'warning',
    );
    return true;
  }

  createWebhook(input: {
    inboxIdOrAddress?: string | null;
    url: string;
    events?: string[];
  }): { webhook: WebhookConfig; signingSecret: string } {
    const check = validateOutboundWebhookUrl(input.url);
    if (!check.ok) throw new Error(check.error);

    let inboxId: string | null = null;
    let inboxAddress: string | undefined;
    if (input.inboxIdOrAddress && input.inboxIdOrAddress.trim()) {
      const inbox = this.database.getInboxByIdOrAddress(input.inboxIdOrAddress);
      if (!inbox) throw new Error('Target inbox not found.');
      inboxId = inbox.id;
      inboxAddress = inbox.address;
    }

    const signingSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    const record = {
      id: `whk_${crypto.randomBytes(6).toString('hex')}`,
      inboxId,
      inboxAddress,
      url: check.url,
      events: input.events?.length ? input.events : ['email.received'],
      enabled: true,
      secretPrefix: `${signingSecret.slice(0, 12)}…`,
      createdAt: new Date().toISOString(),
      secretPlaintext: signingSecret,
    };

    this.database.insertWebhook(record);
    this.recordActivity(
      'webhook:created',
      `Configured webhook listener ${check.url}`,
      inboxAddress,
      `Events: ${record.events.join(', ')}`,
      'success',
    );

    const { secretPlaintext: _hidden, ...publicWebhook } = record;
    return { webhook: publicWebhook, signingSecret };
  }

  listWebhooks(inboxId?: string): WebhookConfig[] {
    return this.database.listWebhooks(inboxId).map(({ secretPlaintext: _h, ...rest }) => rest);
  }

  listWebhooksWithSecrets(inboxId: string) {
    return this.database.listWebhooks(inboxId).filter((w) => w.enabled);
  }

  listGlobalWebhooksWithSecrets() {
    return this.database.listWebhooks().filter((w) => w.enabled && w.inboxId === null);
  }

  getWebhookWithSecret(id: string) {
    return this.database.getWebhookById(id);
  }

  updateWebhook(id: string, patch: { enabled?: boolean; events?: string[] }): WebhookConfig | null {
    const updated = this.database.updateWebhook(id, patch);
    if (!updated) return null;
    const { secretPlaintext: _hidden, ...publicWebhook } = updated;
    return publicWebhook;
  }

  deleteWebhook(id: string): boolean {
    return this.database.deleteWebhook(id);
  }

  recordWebhookDelivery(log: WebhookDeliveryLog): void {
    this.database.insertWebhookDelivery(log);
    this.emit({ type: 'webhook:delivery', delivery: log, inboxId: log.inboxId });
  }

  listWebhookDeliveries(limit = 50): WebhookDeliveryLog[] {
    return this.database.listWebhookDeliveries(limit);
  }

  markInboundEventSeen(eventId: string): boolean {
    return this.database.markInboundEventSeen(eventId);
  }

  recordApiUsage(log: Omit<ApiUsageLog, 'id' | 'timestamp'>): void {
    this.database.insertApiUsageLog({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...log,
    });
  }

  listApiUsageLogs(limit = 50): ApiUsageLog[] {
    return this.database.listApiUsageLogs(limit);
  }

  queryActivities(params: ActivityQueryParams = {}): { activities: ActivityEvent[]; total: number } {
    return this.database.queryActivities(params);
  }

  listActivities(limit = 100): ActivityEvent[] {
    return this.database.queryActivities({ limit }).activities;
  }

  getRetentionDays(): number {
    const raw = this.database.getSetting('retention_days');
    const parsed = Number(raw || process.env.RETENTION_DAYS || 30);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 30;
  }

  setRetentionDays(days: number): number {
    const clamped = Math.min(Math.max(Math.round(days), 1), 365);
    this.database.setSetting('retention_days', String(clamped));
    return clamped;
  }

  getRequireApiKeySetting(): boolean | null {
    const raw = this.database.getSetting('require_api_key');
    if (raw === null) return null;
    return raw === 'true';
  }

  setRequireApiKeySetting(val: boolean): void {
    this.database.setSetting('require_api_key', val ? 'true' : 'false');
  }

  hasEnvAdminPasscode(): boolean {
    return Boolean((process.env.ADMIN_PASSCODE || '').trim());
  }

  isAdminPasscodeConfigured(): boolean {
    return this.hasEnvAdminPasscode() || this.database.getSetting('admin_passcode_hash') !== null;
  }

  private hashAdminPasscode(passcode: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
  }

  private verifyHashedPasscode(passcode: string, storedHash: string): boolean {
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, expectedHex] = parts;
    try {
      const expected = Buffer.from(expectedHex, 'hex');
      const actual = crypto.scryptSync(passcode, salt, expected.length);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  claimInitialAdminPasscode(passcode: string): boolean {
    if (this.hasEnvAdminPasscode()) {
      throw new Error('รหัสผ่านผู้ดูแลถูกกำหนดผ่านตัวแปรสภาพแวดล้อมของเซิร์ฟเวอร์แล้ว');
    }
    const trimmed = passcode.trim();
    if (trimmed.length < 4 || trimmed.length > 128) {
      throw new Error('รหัสผ่านระบบหลังบ้านต้องมีความยาว 4–128 ตัวอักษร');
    }
    const encoded = this.hashAdminPasscode(trimmed);
    const claimed = this.database.insertSettingIfAbsent('admin_passcode_hash', encoded);
    if (claimed) {
      this.recordActivity(
        'auth:event',
        'Configured initial Admin Console passcode',
        undefined,
        undefined,
        'success',
      );
    }
    return claimed;
  }

  verifyAdminPasscode(passcode: string): boolean {
    const envPass = (process.env.ADMIN_PASSCODE || '').trim();
    if (envPass) {
      const a = crypto.createHash('sha256').update(passcode).digest();
      const b = crypto.createHash('sha256').update(envPass).digest();
      return crypto.timingSafeEqual(a, b);
    }
    const storedHash = this.database.getSetting('admin_passcode_hash');
    if (!storedHash) return false;
    return this.verifyHashedPasscode(passcode, storedHash);
  }

  updateAdminPasscode(currentPasscode: string, newPasscode: string): void {
    if (this.hasEnvAdminPasscode()) {
      throw new Error('ไม่สามารถเปลี่ยนรหัสผ่านจากหน้าเว็บได้ เนื่องจากกำหนดผ่าน ADMIN_PASSCODE บนเซิร์ฟเวอร์');
    }
    if (!this.verifyAdminPasscode(currentPasscode)) {
      throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    }
    const trimmed = newPasscode.trim();
    if (trimmed.length < 4 || trimmed.length > 128) {
      throw new Error('รหัสผ่านใหม่ต้องมีความยาว 4–128 ตัวอักษร');
    }
    this.database.setSetting('admin_passcode_hash', this.hashAdminPasscode(trimmed));
    this.recordActivity(
      'auth:event',
      'Updated Admin Console passcode',
      undefined,
      undefined,
      'info',
    );
  }

  runMaintenancePrune(): { expiredInboxes: number; deletedMessages: number; deletedLogs: number } {
    const beforeCount = this.database.listInboxes().length;
    this.pruneExpired();
    const afterCount = this.database.listInboxes().length;
    const pruned = this.database.pruneRetention(this.getRetentionDays());
    return {
      expiredInboxes: Math.max(0, beforeCount - afterCount),
      deletedMessages: pruned.deletedMessages,
      deletedLogs: pruned.deletedLogs,
    };
  }

  getAdminOverview(params: {
    requireApiKey: boolean;
    smtpPort: number | null;
    uptimeSeconds: number;
  }): AdminOverview {
    const allInboxes = this.listInboxes();
    const agg = this.database.getAggregateStats();
    const byProvider: Record<InboxProvider, number> = {
      'mail.tm': 0,
      'gmail-alias': 0,
      'outlook-alias': 0,
      webhook: 0,
      smtp: 0,
    };
    const byStatus: Record<InboxStatus, number> = {
      active: 0,
      paused: 0,
      error: 0,
      expired: 0,
    };
    for (const inb of allInboxes) {
      byProvider[inb.provider] = (byProvider[inb.provider] ?? 0) + 1;
      byStatus[inb.status] = (byStatus[inb.status] ?? 0) + 1;
    }

    const recentErrors = this.database
      .queryActivities({ status: 'error', limit: 8 })
      .activities;

    return {
      inboxesTotal: allInboxes.length,
      messagesTotal: agg.messagesTotal,
      unreadTotal: agg.unreadTotal,
      otpCount: agg.otpMessagesTotal,
      apiKeysCount: this.listApiKeys().length,
      webhooksCount: this.listWebhooks().length,
      deliveriesCount: this.listWebhookDeliveries(200).length,
      byProvider,
      byStatus,
      retentionDays: this.getRetentionDays(),
      requireApiKey: params.requireApiKey,
      smtpPort: params.smtpPort,
      uptimeSeconds: params.uptimeSeconds,
      recentErrors,
    };
  }
}
