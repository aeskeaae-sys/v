import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ActivityEvent,
  ActivityStatus,
  ApiKeyScope,
  ApiUsageLog,
  EmailAttachment,
  EmailMessage,
  ExtractedArtifacts,
  Inbox,
  InboxProvider,
  InboxStatus,
  MessageFolder,
  MessageSource,
  WebhookConfig,
  WebhookDeliveryLog,
} from '../shared/types.ts';
import type { LiveMxCredentials } from './mailtm.ts';
import { SecretCipher } from './crypto.ts';
import { computeMessageContentHash, computeThreadId } from './parser.ts';

export interface StoredInboxRecord extends Inbox {
  credentials?: LiveMxCredentials;
}

export interface StoredApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredWebhookRecord extends WebhookConfig {
  secretPlaintext: string;
}

export interface MessageQueryParams {
  inboxId?: string;
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

export interface ActivityQueryParams {
  type?: string;
  status?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface QueuedJob {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedBy: string | null;
  lastError: string | null;
  idempotencyKey: string | null;
}

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'v1_initial_enterprise_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS inboxes (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        local_part TEXT NOT NULL,
        domain TEXT NOT NULL,
        mode TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'webhook',
        status TEXT NOT NULL DEFAULT 'active',
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_synced_at TEXT,
        sync_error TEXT,
        mx_verified INTEGER,
        webhook_url TEXT,
        credentials_enc TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inboxes_address ON inboxes(address);
      CREATE INDEX IF NOT EXISTS idx_inboxes_expires ON inboxes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_inboxes_created ON inboxes(created_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        remote_id TEXT,
        inbox_id TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        from_name TEXT,
        subject TEXT NOT NULL,
        text_body TEXT NOT NULL,
        html_body TEXT NOT NULL,
        snippet TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        extracted_json TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT 'inbox',
        thread_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        spam_score INTEGER NOT NULL DEFAULT 0,
        spam_reasons_json TEXT NOT NULL DEFAULT '[]',
        read INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        received_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (inbox_id) REFERENCES inboxes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_inbox_folder_date ON messages(inbox_id, folder, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_remote ON messages(inbox_id, remote_id);
      CREATE INDEX IF NOT EXISTS idx_messages_hash ON messages(inbox_id, content_hash);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_created ON api_keys(created_at DESC);

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        inbox_id TEXT,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        secret_prefix TEXT NOT NULL,
        events_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY (inbox_id) REFERENCES inboxes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_inbox ON webhooks(inbox_id);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT,
        inbox_id TEXT NOT NULL,
        inbox_address TEXT,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        target_url TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        attempts INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliv_created ON webhook_deliveries(created_at DESC);

      CREATE TABLE IF NOT EXISTS webhook_seen_events (
        event_id TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'info',
        inbox_address TEXT,
        summary TEXT NOT NULL,
        detail TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activities_ts ON activities(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);

      CREATE TABLE IF NOT EXISTS api_usage_logs (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        auth_type TEXT NOT NULL,
        key_prefix TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON api_usage_logs(timestamp DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'v2_shared_auth_and_rate_limits',
    sql: `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket_key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_key, window_start)
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
    `,
  },
  {
    version: 3,
    name: 'v3_durable_job_queue',
    sql: `
      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        run_at TEXT NOT NULL,
        locked_at TEXT,
        locked_by TEXT,
        last_error TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_queue_ready ON job_queue(status, run_at);

      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        name TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL,
        jobs_processed INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

export class MailboxDatabase {
  public readonly db: DatabaseSync;
  public readonly dbPath: string;
  private readonly cipher: SecretCipher;

  constructor(options?: { dbPath?: string | null; legacyJsonPath?: string | null }) {
    const resolvedDbPath =
      options && 'dbPath' in options
        ? options.dbPath || ':memory:'
        : path.resolve(process.cwd(), process.env.FLOWMAIL_DB_PATH || path.join('.data', 'mailbox.db'));

    this.dbPath = resolvedDbPath;

    const keyDir =
      resolvedDbPath === ':memory:' ? null : path.dirname(path.resolve(resolvedDbPath));
    this.cipher = new SecretCipher(keyDir);

    if (resolvedDbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
    }

    this.db = new DatabaseSync(resolvedDbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (resolvedDbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }

    this.runMigrations();

    if (resolvedDbPath !== ':memory:' && options?.legacyJsonPath !== null) {
      const legacyPath =
        options?.legacyJsonPath ??
        path.resolve(process.cwd(), '.data', 'flowmail-store.json');
      this.importLegacyJsonIfEmpty(legacyPath);
    }
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: number }[];
    const applied = new Set(appliedRows.map((r) => Number(r.version)));

    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  private importLegacyJsonIfEmpty(legacyPath: string): void {
    try {
      if (!legacyPath || !fs.existsSync(legacyPath)) return;
      const existingCount = (
        this.db.prepare('SELECT COUNT(*) AS cnt FROM inboxes').get() as { cnt: number }
      ).cnt;
      if (existingCount > 0) return;

      const raw = fs.readFileSync(legacyPath, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as {
        inboxes?: (Inbox & { credentials?: LiveMxCredentials })[];
        messages?: EmailMessage[];
        apiKeys?: {
          id: string;
          name: string;
          prefix: string;
          keyHash: string;
          createdAt: string;
          lastUsedAt: string | null;
        }[];
        activities?: ActivityEvent[];
      };

      this.db.exec('BEGIN');
      try {
        for (const inb of parsed.inboxes ?? []) {
          const provider: InboxProvider =
            inb.provider ?? (inb.mode === 'live-mx' ? 'mail.tm' : 'webhook');
          this.upsertInbox({
            ...inb,
            provider,
            status: inb.status ?? 'active',
            syncError: inb.syncError ?? null,
            mxVerified: inb.mxVerified ?? null,
          });
        }

        for (const msg of parsed.messages ?? []) {
          if ((msg.source as string) === 'seed' || (msg.source as string) === 'simulator') {
            continue;
          }
          if (!this.getInboxById(msg.inboxId)) continue;
          const folder: MessageFolder = msg.folder ?? 'inbox';
          const threadId = msg.threadId ?? computeThreadId(msg.subject, msg.headers);
          const contentHash =
            msg.contentHash ??
            computeMessageContentHash(msg.inboxId, msg.from, msg.subject, msg.text);
          this.insertMessage({
            ...msg,
            folder,
            threadId,
            contentHash,
            spamScore: msg.spamScore ?? 0,
            spamReasons: msg.spamReasons ?? [],
            deletedAt: msg.deletedAt ?? null,
          });
        }

        for (const k of parsed.apiKeys ?? []) {
          this.insertApiKey({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            keyHash: k.keyHash,
            scopes: ['read', 'write', 'webhooks', 'admin'],
            rateLimitPerMin: 120,
            createdAt: k.createdAt,
            lastUsedAt: k.lastUsedAt,
          });
        }

        for (const act of (parsed.activities ?? []).slice(0, 200)) {
          this.insertActivity({
            ...act,
            status: act.status ?? 'info',
          });
        }

        this.db.exec('COMMIT');
      } catch {
        this.db.exec('ROLLBACK');
      }
    } catch {
      // Ignore legacy parse errors
    }
  }

  insertSession(session: {
    tokenHash: string;
    kind: string;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, kind, scopes_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session.tokenHash,
        session.kind,
        JSON.stringify(session.scopes),
        session.createdAt,
        session.expiresAt,
      );
  }

  getSession(tokenHash: string): {
    tokenHash: string;
    kind: string;
    scopes: string[];
    expiresAt: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT token_hash, kind, scopes_json, expires_at
         FROM auth_sessions
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, new Date().toISOString()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      tokenHash: String(row.token_hash),
      kind: String(row.kind),
      scopes: JSON.parse(String(row.scopes_json || '[]')) as string[],
      expiresAt: String(row.expires_at),
    };
  }

  revokeSession(tokenHash: string): boolean {
    const res = this.db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), tokenHash);
    return Number(res.changes) > 0;
  }

  pruneExpiredSessions(): number {
    const res = this.db
      .prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL')
      .run(new Date().toISOString());
    return Number(res.changes);
  }

  consumeRateLimit(
    bucketKey: string,
    limitPerMin: number,
    nowMs = Date.now(),
  ): { allowed: boolean; remaining: number; resetSec: number } {
    const windowStart = Math.floor(nowMs / 60_000) * 60_000;
    const resetAt = windowStart + 60_000;
    let count = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(bucket_key, window_start) DO UPDATE SET count = count + 1`,
        )
        .run(bucketKey, windowStart);
      const row = this.db
        .prepare('SELECT count FROM rate_limits WHERE bucket_key = ? AND window_start = ?')
        .get(bucketKey, windowStart) as { count: number } | undefined;
      count = Number(row?.count ?? 1);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const allowed = count <= limitPerMin;
    return {
      allowed,
      remaining: Math.max(0, limitPerMin - count),
      resetSec: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)),
    };
  }

  pruneRateLimits(nowMs = Date.now()): number {
    const cutoff = Math.floor(nowMs / 60_000) * 60_000 - 60_000;
    const res = this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(cutoff);
    return Number(res.changes);
  }

  enqueueJob(input: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    runAt?: string;
    idempotencyKey?: string | null;
  }): boolean {
    const nowIso = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO job_queue (
          id, type, payload_json, status, attempts, max_attempts, run_at,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.type,
        JSON.stringify(input.payload),
        input.maxAttempts ?? 5,
        input.runAt ?? nowIso,
        input.idempotencyKey ?? null,
        nowIso,
        nowIso,
      );
    return Number(res.changes) > 0;
  }

  claimJobs(workerId: string, limit = 4, leaseMs = 300_000): QueuedJob[] {
    const nowIso = new Date().toISOString();
    const leaseCutoff = new Date(Date.now() - leaseMs).toISOString();
    const claimed: QueuedJob[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM job_queue
           WHERE status = 'pending' AND run_at <= ?
             AND (locked_at IS NULL OR locked_at < ?)
           ORDER BY run_at ASC LIMIT ?`,
        )
        .all(nowIso, leaseCutoff, Math.min(Math.max(limit, 1), 32)) as Record<string, unknown>[];
      const update = this.db.prepare(
        "UPDATE job_queue SET status = 'running', locked_at = ?, locked_by = ?, updated_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        const res = update.run(nowIso, workerId, nowIso, String(row.id));
        if (Number(res.changes) === 0) continue;
        claimed.push({
          id: String(row.id),
          type: String(row.type),
          status: 'running',
          payload: JSON.parse(String(row.payload_json || '{}')) as Record<string, unknown>,
          attempts: Number(row.attempts ?? 0),
          maxAttempts: Number(row.max_attempts ?? 5),
          runAt: String(row.run_at),
          lockedBy: row.locked_by ? String(row.locked_by) : null,
          lastError: row.last_error ? String(row.last_error) : null,
          idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return claimed;
  }

  completeJob(id: string): void {
    this.db
      .prepare(
        "UPDATE job_queue SET status = 'succeeded', locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), id);
  }

  failJob(id: string, error: string, retryDelaySec: number): 'retry' | 'dead' {
    const nowIso = new Date().toISOString();
    const row = this.db
      .prepare('SELECT attempts, max_attempts FROM job_queue WHERE id = ?')
      .get(id) as { attempts: number; max_attempts: number } | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const maxAttempts = Number(row?.max_attempts ?? 5);
    const dead = attempts >= maxAttempts;
    this.db
      .prepare(
        `UPDATE job_queue
         SET attempts = ?, status = ?, last_error = ?, locked_at = NULL, locked_by = NULL,
             run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        attempts,
        dead ? 'dead' : 'pending',
        error.slice(0, 1000),
        new Date(Date.now() + retryDelaySec * 1000).toISOString(),
        nowIso,
        id,
      );
    return dead ? 'dead' : 'retry';
  }

  recoverStaleJobs(leaseMs = 300_000): number {
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const res = this.db
      .prepare(
        "UPDATE job_queue SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE status = 'running' AND locked_at <= ?",
      )
      .run(cutoff);
    return Number(res.changes);
  }

  recordWorkerHeartbeat(name: string, jobsProcessed: number): void {
    this.db
      .prepare(
        `INSERT INTO worker_heartbeats (name, last_seen, jobs_processed) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen, jobs_processed = excluded.jobs_processed`,
      )
      .run(name, new Date().toISOString(), jobsProcessed);
  }

  listWorkerHeartbeats(): { name: string; lastSeen: string; jobsProcessed: number }[] {
    const rows = this.db
      .prepare('SELECT name, last_seen, jobs_processed FROM worker_heartbeats ORDER BY name')
      .all() as { name: string; last_seen: string; jobs_processed: number }[];
    return rows.map((r) => ({
      name: r.name,
      lastSeen: r.last_seen,
      jobsProcessed: Number(r.jobs_processed),
    }));
  }

  listJobs(limit = 50): QueuedJob[] {
    const rows = this.db
      .prepare('SELECT * FROM job_queue ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type),
      status: String(row.status),
      payload: JSON.parse(String(row.payload_json || '{}')) as Record<string, unknown>,
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 5),
      runAt: String(row.run_at),
      lockedBy: row.locked_by ? String(row.locked_by) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    }));
  }

  getMigrationCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM schema_migrations').get() as {
      cnt: number;
    };
    return Number(row.cnt);
  }

  close(): void {
    this.db.close();
  }

  ping(): boolean {
    try {
      const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number };
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  private mapInboxRow(row: Record<string, unknown>): StoredInboxRecord {
    const inboxId = String(row.id);
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(CASE WHEN folder IN ('inbox', 'spam') THEN 1 END) AS msg_cnt,
           COUNT(CASE WHEN folder IN ('inbox', 'spam') AND read = 0 THEN 1 END) AS unread_cnt
         FROM messages WHERE inbox_id = ?`,
      )
      .get(inboxId) as { msg_cnt: number; unread_cnt: number };

    let credentials: LiveMxCredentials | undefined;
    if (typeof row.credentials_enc === 'string' && row.credentials_enc) {
      const dec = this.cipher.decrypt(row.credentials_enc);
      if (dec) {
        try {
          credentials = JSON.parse(dec) as LiveMxCredentials;
        } catch {
          credentials = undefined;
        }
      }
    }

    return {
      id: inboxId,
      address: String(row.address),
      localPart: String(row.local_part),
      domain: String(row.domain),
      mode: String(row.mode) as Inbox['mode'],
      provider: String(row.provider) as InboxProvider,
      status: String(row.status) as InboxStatus,
      label: String(row.label),
      createdAt: String(row.created_at),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
      syncError: row.sync_error ? String(row.sync_error) : null,
      mxVerified:
        row.mx_verified === null || row.mx_verified === undefined
          ? null
          : Number(row.mx_verified) === 1,
      messageCount: Number(counts?.msg_cnt ?? 0),
      unreadCount: Number(counts?.unread_cnt ?? 0),
      webhookUrl: row.webhook_url ? String(row.webhook_url) : undefined,
      credentials,
    };
  }

  upsertInbox(inbox: StoredInboxRecord): void {
    const encCreds = inbox.credentials
      ? this.cipher.encrypt(JSON.stringify(inbox.credentials))
      : null;

    this.db
      .prepare(
        `INSERT INTO inboxes (
          id, address, local_part, domain, mode, provider, status, label,
          created_at, expires_at, last_synced_at, sync_error, mx_verified,
          webhook_url, credentials_enc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          status = excluded.status,
          expires_at = excluded.expires_at,
          last_synced_at = excluded.last_synced_at,
          sync_error = excluded.sync_error,
          mx_verified = excluded.mx_verified,
          webhook_url = excluded.webhook_url,
          credentials_enc = COALESCE(excluded.credentials_enc, inboxes.credentials_enc)`,
      )
      .run(
        inbox.id,
        inbox.address.toLowerCase(),
        inbox.localPart,
        inbox.domain.toLowerCase(),
        inbox.mode,
        inbox.provider,
        inbox.status,
        inbox.label,
        inbox.createdAt,
        inbox.expiresAt,
        inbox.lastSyncedAt,
        inbox.syncError ?? null,
        inbox.mxVerified === null || inbox.mxVerified === undefined
          ? null
          : inbox.mxVerified
            ? 1
            : 0,
        inbox.webhookUrl ?? null,
        encCreds,
      );
  }

  listInboxes(): StoredInboxRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM inboxes ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapInboxRow(r));
  }

  getInboxById(id: string): StoredInboxRecord | null {
    const row = this.db
      .prepare('SELECT * FROM inboxes WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapInboxRow(row) : null;
  }

  getInboxByIdOrAddress(idOrAddress: string): StoredInboxRecord | null {
    if (!idOrAddress) return null;
    const trimmed = idOrAddress.trim();
    const row = this.db
      .prepare('SELECT * FROM inboxes WHERE id = ? OR LOWER(address) = LOWER(?) LIMIT 1')
      .get(trimmed, trimmed) as Record<string, unknown> | undefined;
    return row ? this.mapInboxRow(row) : null;
  }

  deleteInbox(id: string): boolean {
    const res = this.db.prepare('DELETE FROM inboxes WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  private mapMessageRow(row: Record<string, unknown>): EmailMessage {
    return {
      id: String(row.id),
      remoteId: row.remote_id ? String(row.remote_id) : undefined,
      inboxId: String(row.inbox_id),
      to: String(row.to_addr),
      from: String(row.from_addr),
      fromName: row.from_name ? String(row.from_name) : undefined,
      subject: String(row.subject),
      text: String(row.text_body),
      html: String(row.html_body),
      snippet: String(row.snippet),
      headers: JSON.parse(String(row.headers_json || '{}')) as Record<string, string>,
      attachments: JSON.parse(String(row.attachments_json || '[]')) as EmailAttachment[],
      extracted: JSON.parse(String(row.extracted_json || '{}')) as ExtractedArtifacts,
      folder: String(row.folder || 'inbox') as MessageFolder,
      threadId: String(row.thread_id || ''),
      contentHash: String(row.content_hash || ''),
      spamScore: Number(row.spam_score ?? 0),
      spamReasons: JSON.parse(String(row.spam_reasons_json || '[]')) as string[],
      read: Number(row.read) === 1,
      starred: Number(row.starred) === 1,
      source: String(row.source) as MessageSource,
      receivedAt: String(row.received_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  }

  insertMessage(msg: EmailMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (
          id, remote_id, inbox_id, to_addr, from_addr, from_name, subject,
          text_body, html_body, snippet, headers_json, attachments_json,
          extracted_json, folder, thread_id, content_hash, spam_score,
          spam_reasons_json, read, starred, source, received_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.remoteId ?? null,
        msg.inboxId,
        msg.to,
        msg.from,
        msg.fromName ?? null,
        msg.subject,
        msg.text,
        msg.html,
        msg.snippet,
        JSON.stringify(msg.headers ?? {}),
        JSON.stringify(msg.attachments ?? []),
        JSON.stringify(msg.extracted),
        msg.folder ?? 'inbox',
        msg.threadId,
        msg.contentHash,
        msg.spamScore ?? 0,
        JSON.stringify(msg.spamReasons ?? []),
        msg.read ? 1 : 0,
        msg.starred ? 1 : 0,
        msg.source,
        msg.receivedAt,
        msg.deletedAt ?? null,
      );
  }

  findDuplicateMessage(
    inboxId: string,
    remoteId?: string,
    contentHash?: string,
  ): EmailMessage | null {
    if (remoteId) {
      const byRemote = this.db
        .prepare('SELECT * FROM messages WHERE inbox_id = ? AND remote_id = ? LIMIT 1')
        .get(inboxId, remoteId) as Record<string, unknown> | undefined;
      if (byRemote) return this.mapMessageRow(byRemote);
    }
    if (contentHash) {
      // Only treat identical content hash within last 10 minutes as duplicate webhook/SMTP replay
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const byHash = this.db
        .prepare(
          'SELECT * FROM messages WHERE inbox_id = ? AND content_hash = ? AND received_at >= ? LIMIT 1',
        )
        .get(inboxId, contentHash, cutoff) as Record<string, unknown> | undefined;
      if (byHash) return this.mapMessageRow(byHash);
    }
    return null;
  }

  listKnownRemoteIds(inboxId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT remote_id FROM messages WHERE inbox_id = ? AND remote_id IS NOT NULL')
      .all(inboxId) as { remote_id: string }[];
    return new Set(rows.map((r) => r.remote_id));
  }

  queryMessages(params: MessageQueryParams): { messages: EmailMessage[]; total: number } {
    const clauses: string[] = [];
    const args: (string | number)[] = [];

    if (params.inboxId) {
      clauses.push('inbox_id = ?');
      args.push(params.inboxId);
    }

    if (params.folder && params.folder !== 'all') {
      clauses.push('folder = ?');
      args.push(params.folder);
    } else if (!params.folder) {
      // Default active view excludes trash unless requested
      clauses.push("folder != 'trash'");
    }

    if (params.unreadOnly) {
      clauses.push('read = 0');
    }
    if (params.starredOnly) {
      clauses.push('starred = 1');
    }
    if (params.subject) {
      clauses.push('LOWER(subject) LIKE ?');
      args.push(`%${params.subject.toLowerCase()}%`);
    }
    if (params.from) {
      clauses.push('LOWER(from_addr) LIKE ?');
      args.push(`%${params.from.toLowerCase()}%`);
    }
    if (params.query) {
      const like = `%${params.query.toLowerCase()}%`;
      clauses.push(
        '(LOWER(subject) LIKE ? OR LOWER(from_addr) LIKE ? OR LOWER(COALESCE(from_name, \'\')) LIKE ? OR LOWER(text_body) LIKE ?)',
      );
      args.push(like, like, like, like);
    }
    if (params.hasOtp) {
      clauses.push(`extracted_json NOT LIKE '%"otpCodes":[]%'`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM messages ${where}`)
      .get(...args) as { cnt: number };

    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const offset = Math.max(params.offset ?? 0, 0);

    const rows = this.db
      .prepare(
        `SELECT * FROM messages ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Record<string, unknown>[];

    return {
      messages: rows.map((r) => this.mapMessageRow(r)),
      total: Number(totalRow?.cnt ?? 0),
    };
  }

  getMessage(id: string): EmailMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMessageRow(row) : null;
  }

  updateMessage(
    id: string,
    patch: { read?: boolean; starred?: boolean; folder?: MessageFolder; deletedAt?: string | null },
  ): EmailMessage | null {
    const existing = this.getMessage(id);
    if (!existing) return null;

    const read = typeof patch.read === 'boolean' ? (patch.read ? 1 : 0) : existing.read ? 1 : 0;
    const starred =
      typeof patch.starred === 'boolean' ? (patch.starred ? 1 : 0) : existing.starred ? 1 : 0;
    const folder = patch.folder ?? existing.folder;
    const deletedAt =
      patch.deletedAt !== undefined ? patch.deletedAt : existing.deletedAt ?? null;

    this.db
      .prepare('UPDATE messages SET read = ?, starred = ?, folder = ?, deleted_at = ? WHERE id = ?')
      .run(read, starred, folder, deletedAt, id);

    return this.getMessage(id);
  }

  deleteMessage(id: string): boolean {
    const res = this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  clearInboxMessages(inboxId: string): number {
    const res = this.db.prepare('DELETE FROM messages WHERE inbox_id = ?').run(inboxId);
    return Number(res.changes);
  }

  insertApiKey(key: StoredApiKeyRecord): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, prefix, key_hash, scopes_json, rate_limit_per_min, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key.id,
        key.name,
        key.prefix,
        key.keyHash,
        JSON.stringify(key.scopes),
        key.rateLimitPerMin,
        key.createdAt,
        key.lastUsedAt,
      );
  }

  listApiKeys(): StoredApiKeyRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      prefix: String(r.prefix),
      keyHash: String(r.key_hash),
      scopes: JSON.parse(String(r.scopes_json || '["read"]')) as ApiKeyScope[],
      rateLimitPerMin: Number(r.rate_limit_per_min ?? 120),
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    }));
  }

  touchApiKeyUsed(id: string, timestamp: string): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(timestamp, id);
  }

  deleteApiKey(id: string): boolean {
    const res = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  insertWebhook(record: StoredWebhookRecord): void {
    const encSecret = this.cipher.encrypt(record.secretPlaintext);
    this.db
      .prepare(
        `INSERT INTO webhooks (id, inbox_id, url, secret_enc, secret_prefix, events_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.inboxId,
        record.url,
        encSecret,
        record.secretPrefix,
        JSON.stringify(record.events),
        record.enabled ? 1 : 0,
        record.createdAt,
      );
  }

  listWebhooks(inboxId?: string): StoredWebhookRecord[] {
    const sql = inboxId
      ? `SELECT w.*, i.address AS inbox_address
         FROM webhooks w LEFT JOIN inboxes i ON w.inbox_id = i.id
         WHERE w.inbox_id = ? OR w.inbox_id IS NULL
         ORDER BY w.created_at DESC`
      : `SELECT w.*, i.address AS inbox_address
         FROM webhooks w LEFT JOIN inboxes i ON w.inbox_id = i.id
         ORDER BY w.created_at DESC`;
    const rows = (inboxId ? this.db.prepare(sql).all(inboxId) : this.db.prepare(sql).all()) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: String(r.id),
      inboxId: r.inbox_id ? String(r.inbox_id) : null,
      inboxAddress: r.inbox_address ? String(r.inbox_address) : undefined,
      url: String(r.url),
      events: JSON.parse(String(r.events_json || '["email.received"]')) as string[],
      enabled: Number(r.enabled) === 1,
      secretPrefix: String(r.secret_prefix),
      createdAt: String(r.created_at),
      secretPlaintext: this.cipher.decrypt(String(r.secret_enc)),
    }));
  }

  getWebhookById(id: string): StoredWebhookRecord | null {
    const r = this.db
      .prepare(
        `SELECT w.*, i.address AS inbox_address
         FROM webhooks w LEFT JOIN inboxes i ON w.inbox_id = i.id
         WHERE w.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      inboxId: r.inbox_id ? String(r.inbox_id) : null,
      inboxAddress: r.inbox_address ? String(r.inbox_address) : undefined,
      url: String(r.url),
      events: JSON.parse(String(r.events_json || '["email.received"]')) as string[],
      enabled: Number(r.enabled) === 1,
      secretPrefix: String(r.secret_prefix),
      createdAt: String(r.created_at),
      secretPlaintext: this.cipher.decrypt(String(r.secret_enc)),
    };
  }

  updateWebhook(
    id: string,
    patch: { enabled?: boolean; events?: string[] },
  ): StoredWebhookRecord | null {
    const existing = this.getWebhookById(id);
    if (!existing) return null;
    const nextEnabled =
      typeof patch.enabled === 'boolean' ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
    const nextEvents =
      Array.isArray(patch.events) && patch.events.length > 0 ? patch.events : existing.events;
    this.db
      .prepare('UPDATE webhooks SET enabled = ?, events_json = ? WHERE id = ?')
      .run(nextEnabled, JSON.stringify(nextEvents), id);
    return this.getWebhookById(id);
  }

  deleteWebhook(id: string): boolean {
    const res = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  insertWebhookDelivery(log: WebhookDeliveryLog): void {
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries (
          id, webhook_id, inbox_id, inbox_address, event_id, event_type,
          target_url, status, http_status, attempts, error, created_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.id,
        log.webhookId,
        log.inboxId,
        log.inboxAddress ?? null,
        log.eventId,
        log.eventType,
        log.targetUrl,
        log.status,
        log.httpStatus,
        log.attempts,
        log.error ?? null,
        log.createdAt,
        log.deliveredAt ?? null,
      );
  }

  listWebhookDeliveries(limit = 50): WebhookDeliveryLog[] {
    const rows = this.db
      .prepare('SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(limit, 200)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      webhookId: r.webhook_id ? String(r.webhook_id) : null,
      inboxId: String(r.inbox_id),
      inboxAddress: r.inbox_address ? String(r.inbox_address) : undefined,
      eventId: String(r.event_id),
      eventType: String(r.event_type),
      targetUrl: String(r.target_url),
      status: String(r.status) as WebhookDeliveryLog['status'],
      httpStatus: r.http_status === null ? null : Number(r.http_status),
      attempts: Number(r.attempts),
      error: r.error ? String(r.error) : null,
      createdAt: String(r.created_at),
      deliveredAt: r.delivered_at ? String(r.delivered_at) : null,
    }));
  }

  markInboundEventSeen(eventId: string): boolean {
    // Returns true if inserted (new event), false if duplicate
    const nowIso = new Date().toISOString();
    this.db.prepare('DELETE FROM webhook_seen_events WHERE expires_at <= ?').run(nowIso);
    const existing = this.db
      .prepare('SELECT event_id FROM webhook_seen_events WHERE event_id = ?')
      .get(eventId);
    if (existing) return false;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare('INSERT INTO webhook_seen_events (event_id, expires_at) VALUES (?, ?)')
      .run(eventId, expiresAt);
    return true;
  }

  insertActivity(ev: ActivityEvent): void {
    this.db
      .prepare(
        `INSERT INTO activities (id, type, status, inbox_address, summary, detail, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.id,
        ev.type,
        ev.status ?? 'info',
        ev.inboxAddress ?? null,
        ev.summary,
        ev.detail ?? null,
        ev.timestamp,
      );
  }

  queryActivities(params: ActivityQueryParams = {}): { activities: ActivityEvent[]; total: number } {
    const clauses: string[] = [];
    const args: (string | number)[] = [];

    if (params.type && params.type !== 'all') {
      clauses.push('type = ?');
      args.push(params.type);
    }
    if (params.status && params.status !== 'all') {
      clauses.push('status = ?');
      args.push(params.status);
    }
    if (params.from) {
      clauses.push('timestamp >= ?');
      args.push(params.from);
    }
    if (params.to) {
      clauses.push('timestamp <= ?');
      args.push(params.to);
    }
    if (params.query) {
      const like = `%${params.query.toLowerCase()}%`;
      clauses.push(
        '(LOWER(summary) LIKE ? OR LOWER(COALESCE(detail, \'\')) LIKE ? OR LOWER(COALESCE(inbox_address, \'\')) LIKE ?)',
      );
      args.push(like, like, like);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM activities ${where}`)
      .get(...args) as { cnt: number };

    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const offset = Math.max(params.offset ?? 0, 0);

    const rows = this.db
      .prepare(`SELECT * FROM activities ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Record<string, unknown>[];

    return {
      activities: rows.map((r) => ({
        id: String(r.id),
        type: String(r.type) as ActivityEvent['type'],
        status: String(r.status || 'info') as ActivityStatus,
        inboxAddress: r.inbox_address ? String(r.inbox_address) : undefined,
        summary: String(r.summary),
        detail: r.detail ? String(r.detail) : undefined,
        timestamp: String(r.timestamp),
      })),
      total: Number(totalRow?.cnt ?? 0),
    };
  }

  insertApiUsageLog(log: ApiUsageLog): void {
    this.db
      .prepare(
        `INSERT INTO api_usage_logs (id, method, path, status, duration_ms, auth_type, key_prefix, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.id,
        log.method,
        log.path,
        log.status,
        log.durationMs,
        log.authType,
        log.keyPrefix ?? null,
        log.timestamp,
      );
  }

  listApiUsageLogs(limit = 50): ApiUsageLog[] {
    const rows = this.db
      .prepare('SELECT * FROM api_usage_logs ORDER BY timestamp DESC LIMIT ?')
      .all(Math.min(limit, 200)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      method: String(r.method),
      path: String(r.path),
      status: Number(r.status),
      durationMs: Number(r.duration_ms),
      authType: String(r.auth_type) as ApiUsageLog['authType'],
      keyPrefix: r.key_prefix ? String(r.key_prefix) : null,
      timestamp: String(r.timestamp),
    }));
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  insertSettingIfAbsent(key: string, value: string): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value);
    return Number(res.changes) > 0;
  }

  getAggregateStats(): { messagesTotal: number; unreadTotal: number; otpMessagesTotal: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN read = 0 AND folder = 'inbox' THEN 1 ELSE 0 END) AS unread,
           SUM(CASE WHEN folder != 'trash' AND extracted_json != '{"otpCodes":[],"links":[],"primaryOtp":null,"primaryActionUrl":null}' THEN 1 ELSE 0 END) AS otp_msgs
         FROM messages`,
      )
      .get() as { total?: number; unread?: number; otp_msgs?: number } | undefined;
    return {
      messagesTotal: Number(row?.total ?? 0),
      unreadTotal: Number(row?.unread ?? 0),
      otpMessagesTotal: Number(row?.otp_msgs ?? 0),
    };
  }

  pruneRetention(retentionDays: number): { deletedMessages: number; deletedLogs: number } {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const trashCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const m1 = this.db
      .prepare("DELETE FROM messages WHERE folder = 'trash' AND deleted_at IS NOT NULL AND deleted_at <= ?")
      .run(trashCutoff);
    const m2 = this.db
      .prepare('DELETE FROM messages WHERE received_at <= ?')
      .run(cutoff);
    const a1 = this.db.prepare('DELETE FROM activities WHERE timestamp <= ?').run(cutoff);
    const u1 = this.db.prepare('DELETE FROM api_usage_logs WHERE timestamp <= ?').run(cutoff);
    const d1 = this.db.prepare('DELETE FROM webhook_deliveries WHERE created_at <= ?').run(cutoff);
    return {
      deletedMessages: Number(m1.changes) + Number(m2.changes),
      deletedLogs: Number(a1.changes) + Number(u1.changes) + Number(d1.changes),
    };
  }
}
