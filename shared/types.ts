export const WEBHOOK_DOMAINS = [
  'relaybox.dev',
  'mail.relaybox.dev',
  'flowmail.cc',
  'mail.flowmail.cc',
] as const;

export const GMAIL_ALIAS_DOMAINS = ['gmail.com', 'googlemail.com'] as const;

export const OUTLOOK_ALIAS_DOMAINS = [
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
] as const;

export type InboxMode = 'live-mx' | 'webhook' | 'alias';

export type InboxProvider =
  | 'mail.tm'
  | 'webhook'
  | 'smtp'
  | 'gmail-alias'
  | 'outlook-alias';

export type InboxStatus = 'active' | 'paused' | 'error' | 'expired';

export type TtlPreset = '15m' | '1h' | '24h' | '7d' | 'never';

export type MessageFolder = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash';

export interface Inbox {
  id: string;
  address: string;
  localPart: string;
  domain: string;
  mode: InboxMode;
  provider: InboxProvider;
  status: InboxStatus;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  syncError?: string | null;
  mxVerified?: boolean | null;
  messageCount: number;
  unreadCount: number;
  webhookUrl?: string;
}

export interface ExtractedLink {
  url: string;
  label?: string;
  kind: 'verification' | 'reset' | 'magic-link' | 'general';
}

export interface ExtractedArtifacts {
  otpCodes: string[];
  links: ExtractedLink[];
  primaryOtp: string | null;
  primaryActionUrl: string | null;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export type MessageSource = 'live-mx' | 'api' | 'webhook' | 'smtp' | 'outbound' | 'gmail';

export interface EmailMessage {
  id: string;
  remoteId?: string;
  inboxId: string;
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  html: string;
  snippet: string;
  headers: Record<string, string>;
  attachments: EmailAttachment[];
  extracted: ExtractedArtifacts;
  folder: MessageFolder;
  threadId: string;
  contentHash: string;
  spamScore: number;
  spamReasons: string[];
  read: boolean;
  starred: boolean;
  source: MessageSource;
  receivedAt: string;
  deletedAt?: string | null;
}

export type ApiKeyScope = 'read' | 'write' | 'webhooks' | 'admin';

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export type ActivityEventType =
  | 'inbox:created'
  | 'inbox:updated'
  | 'inbox:deleted'
  | 'address:switched'
  | 'email:received'
  | 'email:read'
  | 'email:sent'
  | 'otp:detected'
  | 'wait:matched'
  | 'wait:timeout'
  | 'key:created'
  | 'key:revoked'
  | 'webhook:created'
  | 'webhook:delivered'
  | 'webhook:failed'
  | 'webhook:retry'
  | 'system:maintenance'
  | 'inbox:synced'
  | 'auth:failed'
  | 'auth:event'
  | 'smtp:test';

export type ActivityStatus = 'success' | 'warning' | 'error' | 'info';

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  status: ActivityStatus;
  inboxAddress?: string;
  summary: string;
  detail?: string;
  timestamp: string;
}

export interface WebhookConfig {
  id: string;
  inboxId: string | null;
  inboxAddress?: string;
  url: string;
  events: string[];
  enabled: boolean;
  secretPrefix: string;
  createdAt: string;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string | null;
  inboxId: string;
  inboxAddress?: string;
  eventId: string;
  eventType: string;
  targetUrl: string;
  status: 'delivered' | 'retrying' | 'failed';
  httpStatus: number | null;
  attempts: number;
  error?: string | null;
  createdAt: string;
  deliveredAt?: string | null;
}

export interface ApiUsageLog {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  authType: 'session' | 'api-key' | 'anonymous';
  keyPrefix?: string | null;
  timestamp: string;
}

export interface OtpEntry {
  messageId: string;
  inboxId: string;
  inboxAddress: string;
  from: string;
  fromName?: string;
  subject: string;
  otpCodes: string[];
  links: ExtractedLink[];
  receivedAt: string;
}

export interface IngestEmailPayload {
  to: string;
  from?: string;
  fromName?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
  autoCreateInbox?: boolean;
  source?: MessageSource;
  remoteId?: string;
  receivedAt?: string;
  folder?: MessageFolder;
}

export interface HealthComponentStatus {
  status: 'ok' | 'degraded' | 'unavailable';
  detail: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptimeSeconds: number;
  components: {
    application: HealthComponentStatus;
    database: HealthComponentStatus;
    emailProvider: HealthComponentStatus;
    synchronizationEngine: HealthComponentStatus;
    webhookProcessing: HealthComponentStatus;
  };
}

export interface AdminStatus {
  configured: boolean;
  authenticated: boolean;
  envManaged: boolean;
}

export interface AdminOverview {
  inboxesTotal: number;
  messagesTotal: number;
  unreadTotal: number;
  otpCount: number;
  apiKeysCount: number;
  webhooksCount: number;
  deliveriesCount: number;
  byProvider: Record<InboxProvider, number>;
  byStatus: Record<InboxStatus, number>;
  retentionDays: number;
  requireApiKey: boolean;
  smtpPort: number | null;
  uptimeSeconds: number;
  recentErrors: ActivityEvent[];
}
