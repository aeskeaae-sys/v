import type {
  ActivityEvent,
  AdminOverview,
  AdminStatus,
  ApiKeyScope,
  ApiKeySummary,
  ApiUsageLog,
  EmailMessage,
  HealthReport,
  Inbox,
  InboxMode,
  InboxProvider,
  InboxStatus,
  MessageFolder,
  OtpEntry,
  TtlPreset,
  WebhookConfig,
  WebhookDeliveryLog,
} from '../../shared/types';

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

function apiUrl(path: string): string {
  if (!API_BASE_URL) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

type SessionCredentials = { passcode?: string; apiKey?: string };

let inMemorySessionToken: string | null = null;
let sessionPromise: Promise<string> | null = null;
let sessionCredentials: SessionCredentials | null = null;
let inMemoryAdminToken: string | null = null;

export function configureSessionCredentials(credentials: SessionCredentials): void {
  sessionCredentials = { ...credentials };
  inMemorySessionToken = null;
  sessionPromise = null;
}

export function clearSessionCredentials(): void {
  sessionCredentials = null;
  inMemorySessionToken = null;
  sessionPromise = null;
}

async function ensureSessionToken(): Promise<string> {
  if (inMemorySessionToken) return inMemorySessionToken;
  if (!sessionPromise) {
    const init: RequestInit = { method: 'POST' };
    if (sessionCredentials && Object.keys(sessionCredentials).length > 0) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(sessionCredentials);
    }
    sessionPromise = fetch(apiUrl('/api/v1/session'), init)
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to initialize workspace session.');
        const data = (await res.json()) as { token: string };
        inMemorySessionToken = data.token;
        return data.token;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }
  return sessionPromise;
}

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await ensureSessionToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let res = await fetch(apiUrl(url), { ...init, headers });
  if (res.status === 401) {
    inMemorySessionToken = null;
    const freshToken = await ensureSessionToken();
    headers.set('Authorization', `Bearer ${freshToken}`);
    res = await fetch(apiUrl(url), { ...init, headers });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function getHealthReport(): Promise<HealthReport> {
  const res = await fetch(apiUrl('/api/health'));
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Health check failed (${res.status})`);
  return data as HealthReport;
}

export async function validateDomainMx(
  domain: string,
  force = false,
): Promise<{
  domain: string;
  mxVerified: boolean;
  records: Array<{ exchange: string; priority: number }>;
  checkedAt: string;
  error?: string;
  isLiveMxSupported: boolean;
  isWebhookDomain: boolean;
}> {
  const qs = new URLSearchParams({ domain });
  if (force) qs.set('force', 'true');
  return apiFetch(`/api/v1/domains/validate?${qs.toString()}`);
}

export async function listInboxes(): Promise<{
  inboxes: Inbox[];
  liveMxDomains: string[];
  webhookDomains: string[];
}> {
  return apiFetch('/api/v1/inboxes');
}

export async function createInbox(input: {
  mode?: InboxMode;
  provider?: InboxProvider;
  prefix?: string;
  domain?: string;
  baseEmail?: string;
  tag?: string;
  strategy?: 'plus' | 'dot';
  ttl?: TtlPreset;
  label?: string;
  webhookUrl?: string;
  deliverCredentialsEmail?: boolean;
}): Promise<{ inbox: Inbox }> {
  return apiFetch('/api/v1/inboxes', {
    method: 'POST',
    body: JSON.stringify({
      ...input,
      deliverCredentialsEmail: input.deliverCredentialsEmail ?? true,
    }),
  });
}

export async function updateAddress(
  idOrAddress: string,
  patch: {
    label?: string;
    status?: InboxStatus;
    webhookUrl?: string | null;
    ttl?: TtlPreset;
  },
): Promise<{ inbox: Inbox }> {
  return apiFetch(`/api/v1/addresses/${encodeURIComponent(idOrAddress)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function switchAddress(idOrAddress: string): Promise<{ inbox: Inbox }> {
  return apiFetch(`/api/v1/addresses/${encodeURIComponent(idOrAddress)}/switch`, {
    method: 'POST',
  });
}

export async function syncInbox(idOrAddress: string): Promise<{
  inbox: Inbox;
  newMessages: number;
  messages: EmailMessage[];
}> {
  return apiFetch(`/api/v1/inboxes/${encodeURIComponent(idOrAddress)}/sync`, {
    method: 'POST',
  });
}

export async function importInboxMessages(
  idOrAddress: string,
  messages: Array<{
    remoteId?: string;
    from?: string;
    fromName?: string;
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    source?: 'gmail' | 'api';
    receivedAt?: string;
  }>,
): Promise<{
  inbox: Inbox;
  newMessages: number;
  messages: EmailMessage[];
}> {
  return apiFetch(`/api/v1/inboxes/${encodeURIComponent(idOrAddress)}/import-messages`, {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
}

export async function deleteInbox(idOrAddress: string): Promise<void> {
  await apiFetch(`/api/v1/inboxes/${encodeURIComponent(idOrAddress)}`, {
    method: 'DELETE',
  });
}

export async function clearInbox(idOrAddress: string): Promise<{ cleared: number }> {
  return apiFetch(`/api/v1/inboxes/${encodeURIComponent(idOrAddress)}/clear`, {
    method: 'POST',
  });
}

export async function updateInboxWebhook(
  idOrAddress: string,
  webhookUrl: string | null,
): Promise<{ inbox: Inbox }> {
  return apiFetch(`/api/v1/inboxes/${encodeURIComponent(idOrAddress)}/webhook`, {
    method: 'PATCH',
    body: JSON.stringify({ webhookUrl }),
  });
}

export async function testInboxWebhook(
  idOrAddress: string,
  webhookUrl?: string,
): Promise<{
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  eventId: string;
  error: string | null;
}> {
  const token = await ensureSessionToken();
  const res = await fetch(`/api/v1/inboxes/${encodeURIComponent(idOrAddress)}/webhook/test`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ webhookUrl }),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Webhook test failed (${res.status})`);
  return data;
}

export async function ingestInboundEmail(input: {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  autoCreateInbox?: boolean;
  eventId?: string;
}): Promise<{
  message?: EmailMessage;
  otp?: string | null;
  actionUrl?: string | null;
  duplicate?: boolean;
}> {
  const headers: Record<string, string> = {};
  if (input.eventId) headers['X-Event-Id'] = input.eventId;
  return apiFetch('/api/v1/inbound', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      to: input.to,
      from: input.from,
      subject: input.subject,
      text: input.text,
      html: input.html,
      autoCreateInbox: input.autoCreateInbox ?? true,
    }),
  });
}

export async function listMessages(
  idOrAddress: string,
  sync = true,
  opts?: {
    folder?: MessageFolder | 'all';
    q?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ inbox: Inbox; messages: EmailMessage[]; total?: number }> {
  const qs = new URLSearchParams();
  if (!sync) qs.set('sync', 'false');
  if (opts?.folder) qs.set('folder', opts.folder);
  if (opts?.q) qs.set('q', opts.q);
  if (opts?.limit) qs.set('limit', String(opts.limit));
  if (opts?.offset) qs.set('offset', String(opts.offset));
  const query = qs.toString();
  return apiFetch(
    `/api/v1/inboxes/${encodeURIComponent(idOrAddress)}/messages${query ? `?${query}` : ''}`,
  );
}

export async function sendOrSaveDraft(input: {
  inboxId: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  mode: 'sent' | 'drafts';
}): Promise<{ message: EmailMessage }> {
  return apiFetch('/api/v1/messages/send', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateMessage(
  messageId: string,
  patch: { read?: boolean; starred?: boolean; folder?: MessageFolder },
): Promise<{ message: EmailMessage }> {
  return apiFetch(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function restoreMessage(messageId: string): Promise<{ message: EmailMessage }> {
  return apiFetch(`/api/v1/messages/${encodeURIComponent(messageId)}/restore`, {
    method: 'POST',
  });
}

export async function deleteMessage(messageId: string, permanent = false): Promise<void> {
  const qs = permanent ? '?permanent=true' : '';
  await apiFetch(`/api/v1/messages/${encodeURIComponent(messageId)}${qs}`, {
    method: 'DELETE',
  });
}

export type BulkMessageAction =
  | 'markRead'
  | 'markUnread'
  | 'star'
  | 'unstar'
  | 'delete'
  | 'restore';

export async function bulkMessageAction(
  messageIds: string[],
  action: BulkMessageAction,
  permanent = false,
): Promise<{ affected: number; updated: EmailMessage[]; deletedIds: string[] }> {
  return apiFetch('/api/v1/messages/bulk', {
    method: 'POST',
    body: JSON.stringify({ messageIds, action, permanent }),
  });
}

export async function listOtpEntries(opts?: {
  inboxId?: string;
  q?: string;
  kind?: 'all' | 'otp' | 'links';
  limit?: number;
}): Promise<{ items: OtpEntry[]; total: number }> {
  const qs = new URLSearchParams();
  if (opts?.inboxId) qs.set('inboxId', opts.inboxId);
  if (opts?.q) qs.set('q', opts.q);
  if (opts?.kind) qs.set('kind', opts.kind);
  if (opts?.limit) qs.set('limit', String(opts.limit));
  const query = qs.toString();
  return apiFetch(`/api/v1/otp${query ? `?${query}` : ''}`);
}

export async function listApiKeys(): Promise<{ keys: ApiKeySummary[] }> {
  return apiFetch('/api/v1/keys');
}

export async function createApiKey(
  name: string,
  scopes: ApiKeyScope[] = ['read', 'write', 'webhooks', 'admin'],
  rateLimitPerMin = 120,
): Promise<{ key: ApiKeySummary; plaintextKey: string }> {
  return apiFetch('/api/v1/keys', {
    method: 'POST',
    body: JSON.stringify({ name, scopes, rateLimitPerMin }),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await apiFetch(`/api/v1/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function listWebhooks(inboxId?: string): Promise<{ webhooks: WebhookConfig[] }> {
  const qs = inboxId ? `?inboxId=${encodeURIComponent(inboxId)}` : '';
  return apiFetch(`/api/v1/webhooks${qs}`);
}

export async function createWebhook(input: {
  url: string;
  inboxId?: string;
  events?: string[];
}): Promise<{ webhook: WebhookConfig; signingSecret: string }> {
  return apiFetch('/api/v1/webhooks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateWebhook(
  id: string,
  patch: { enabled?: boolean; events?: string[] },
): Promise<{ webhook: WebhookConfig }> {
  return apiFetch(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function testWebhook(id: string): Promise<{
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  eventId: string;
  error: string | null;
}> {
  const token = await ensureSessionToken();
  const res = await fetch(`/api/v1/webhooks/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Webhook test failed (${res.status})`);
  return data;
}

export async function deleteWebhook(id: string): Promise<void> {
  await apiFetch(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function listWebhookDeliveries(
  limit = 30,
): Promise<{ deliveries: WebhookDeliveryLog[] }> {
  return apiFetch(`/api/v1/webhooks/deliveries?limit=${limit}`);
}

export async function getSmtpStatus(): Promise<{
  inbound: {
    host: string;
    port: number | null;
    protocol: string;
    authRequired: boolean;
    tls: boolean;
  };
  outbound: {
    configured: boolean;
    host: string | null;
    port: number;
    secure: boolean;
  };
}> {
  return apiFetch('/api/v1/smtp/status');
}

export async function testSmtp(input: {
  host?: string;
  port?: number;
  secure?: boolean;
}): Promise<{
  ok: boolean;
  host: string;
  port: number;
  secure: boolean;
  latencyMs: number;
  banner?: string;
  error?: string;
}> {
  const token = await ensureSessionToken();
  const res = await fetch(apiUrl('/api/v1/smtp/test'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`SMTP test failed (${res.status})`);
  return data;
}

export async function getSettings(): Promise<{
  requireApiKey: boolean;
  retentionDays?: number;
  liveMxDomains: string[];
  webhookDomains: string[];
  smtpPort: number | null;
  smtpAuthRequired?: boolean;
  outboundSmtp?: {
    configured: boolean;
    host: string | null;
    port: number;
    secure: boolean;
  };
}> {
  return apiFetch('/api/v1/settings');
}

export async function updateSettings(
  requireApiKey?: boolean,
  retentionDays?: number,
): Promise<{
  requireApiKey: boolean;
  retentionDays?: number;
  liveMxDomains: string[];
  webhookDomains: string[];
  smtpPort: number | null;
}> {
  return apiFetch('/api/v1/settings', {
    method: 'PATCH',
    body: JSON.stringify({ requireApiKey, retentionDays }),
  });
}

export async function listActivities(params?: {
  type?: string;
  status?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  activities: ActivityEvent[];
  total: number;
  limit?: number;
  offset?: number;
}> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set('type', params.type);
  if (params?.status) qs.set('status', params.status);
  if (params?.q) qs.set('q', params.q);
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const query = qs.toString();
  return apiFetch(`/api/v1/activity${query ? `?${query}` : ''}`);
}

export async function downloadActivityExport(format: 'csv' | 'json'): Promise<void> {
  const token = await ensureSessionToken();
  const res = await fetch(`/api/v1/activity/export?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = format === 'csv' ? 'relaybox-activity.csv' : 'relaybox-activity.json';
  a.click();
  URL.revokeObjectURL(url);
}

export async function listApiUsage(limit = 30): Promise<{ usage: ApiUsageLog[] }> {
  return apiFetch(`/api/v1/usage?limit=${limit}`);
}

export async function subscribeToEvents(
  onStoreEvent: (event: {
    type: string;
    inboxId?: string;
    inboxAddress?: string;
    inbox?: Inbox;
    message?: EmailMessage;
    messageId?: string;
    delivery?: WebhookDeliveryLog;
    activity?: ActivityEvent;
  }) => void,
  onConnectionChange: (connected: boolean) => void,
): Promise<() => void> {
  let stopped = false;
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = 1000;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const wait = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, 15000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, wait);
  };

  const connect = async () => {
    if (stopped) return;
    try {
      const token = await ensureSessionToken();
      if (stopped) return;

      const source = new EventSource(`/api/v1/events?token=${encodeURIComponent(token)}`);
      es = source;

      source.addEventListener('connected', () => {
        if (stopped || es !== source) return;
        retryDelayMs = 1000;
        onConnectionChange(true);
      });

      source.addEventListener('store', (ev) => {
        if (stopped || es !== source) return;
        try {
          const parsed = JSON.parse((ev as MessageEvent).data);
          onStoreEvent(parsed);
        } catch {
          // Ignore malformed SSE payload
        }
      });

      source.onerror = () => {
        if (es === source) {
          source.close();
          es = null;
        }
        onConnectionChange(false);
        if (!stopped) {
          // Session token may have been invalidated by a server restart; force fresh token on retry.
          inMemorySessionToken = null;
          scheduleReconnect();
        }
      };
    } catch {
      onConnectionChange(false);
      inMemorySessionToken = null;
      scheduleReconnect();
    }
  };

  await connect();

  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Separated Backend Admin API Client (in-memory Bearer token only)
// ---------------------------------------------------------------------------
export class AdminUnauthorizedError extends Error {
  constructor(message = 'ต้องเข้าสู่ระบบหลังบ้าน (Admin) ก่อนดำเนินการ') {
    super(message);
    this.name = 'AdminUnauthorizedError';
  }
}

export function hasInMemoryAdminToken(): boolean {
  return Boolean(inMemoryAdminToken);
}

export function clearAdminSessionToken(): void {
  inMemoryAdminToken = null;
}

async function adminFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (inMemoryAdminToken) {
    headers.set('Authorization', `Bearer ${inMemoryAdminToken}`);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(apiUrl(url), { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    inMemoryAdminToken = null;
    throw new AdminUnauthorizedError((data as { error?: string }).error);
  }
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Admin request failed (${res.status})`);
  }
  return data as T;
}

export async function getAdminStatus(): Promise<AdminStatus> {
  const headers: Record<string, string> = {};
  if (inMemoryAdminToken) {
    headers.Authorization = `Bearer ${inMemoryAdminToken}`;
  }
  const res = await fetch(apiUrl('/api/admin/status'), { headers });
  const data = (await res.json().catch(() => null)) as AdminStatus | null;
  if (!res.ok || !data) {
    throw new Error(`Admin status check failed (${res.status})`);
  }
  if (!data.authenticated) {
    inMemoryAdminToken = null;
  }
  return data;
}

export async function setupAdminPasscode(
  passcode: string,
): Promise<{ token: string; status: AdminStatus }> {
  const res = await fetch(apiUrl('/api/admin/setup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || 'ตั้งรหัสผ่านไม่สำเร็จ');
  }
  const typed = data as { token: string; status: AdminStatus };
  inMemoryAdminToken = typed.token;
  configureSessionCredentials({ passcode });
  void ensureSessionToken().catch(() => {});
  return typed;
}

export async function loginAdmin(
  passcode: string,
): Promise<{ token: string; status: AdminStatus }> {
  const res = await fetch(apiUrl('/api/admin/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || 'เข้าสู่ระบบไม่สำเร็จ');
  }
  const typed = data as { token: string; status: AdminStatus };
  inMemoryAdminToken = typed.token;
  configureSessionCredentials({ passcode });
  void ensureSessionToken().catch(() => {});
  return typed;
}

export async function logoutAdmin(): Promise<void> {
  const token = inMemoryAdminToken;
  const sessionToken = inMemorySessionToken;
  inMemoryAdminToken = null;
  clearSessionCredentials();
  const requests: Promise<unknown>[] = [];
  if (token) {
    requests.push(
      fetch(apiUrl('/api/admin/logout'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {}),
    );
  }
  if (sessionToken) {
    requests.push(
      fetch(apiUrl('/api/v1/session/logout'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      }).catch(() => {}),
    );
  }
  await Promise.all(requests);
}

export async function getAdminOverview(): Promise<{
  overview: AdminOverview;
  liveMxDomains: string[];
  webhookDomains: string[];
}> {
  return adminFetch('/api/admin/overview');
}

export async function listAdminInboxes(params?: {
  q?: string;
  provider?: string;
  status?: string;
}): Promise<{ inboxes: Inbox[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set('q', params.q);
  if (params?.provider && params.provider !== 'all') qs.set('provider', params.provider);
  if (params?.status && params.status !== 'all') qs.set('status', params.status);
  const query = qs.toString();
  return adminFetch(`/api/admin/inboxes${query ? `?${query}` : ''}`);
}

export async function updateAdminInbox(
  idOrAddress: string,
  patch: { label?: string; status?: InboxStatus; ttl?: TtlPreset; webhookUrl?: string | null },
): Promise<{ inbox: Inbox }> {
  return adminFetch(`/api/admin/inboxes/${encodeURIComponent(idOrAddress)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteAdminInbox(idOrAddress: string): Promise<{ deleted: boolean }> {
  return adminFetch(`/api/admin/inboxes/${encodeURIComponent(idOrAddress)}`, {
    method: 'DELETE',
  });
}

export async function runAdminMaintenancePrune(): Promise<{
  expiredInboxes: number;
  deletedMessages: number;
  deletedLogs: number;
}> {
  return adminFetch('/api/admin/maintenance/prune', { method: 'POST' });
}

export async function changeAdminPasscode(
  currentPasscode: string,
  newPasscode: string,
): Promise<{ ok: boolean }> {
  return adminFetch('/api/admin/passcode', {
    method: 'POST',
    body: JSON.stringify({ currentPasscode, newPasscode }),
  });
}
