export const WEBHOOK_DOMAINS = [
  'relaybox.dev',
  'mail.relaybox.dev',
  'flowmail.cc',
  'mail.flowmail.cc',
] as const;

export type WebhookDomain = (typeof WEBHOOK_DOMAINS)[number];

export type InboxMode = 'live-mx' | 'webhook' | 'smtp';
export type InboxStatus = 'active' | 'expired' | 'disabled';
export type MessageFolder = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash';

export interface InboxAddress {
  id: string;
  address: string;
  localPart: string;
  domain: string;
  mode: InboxMode;
  provider: string;
  status: InboxStatus;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  mxVerified: boolean;
  messageCount: number;
  unreadCount: number;
}

export interface MessageSummary {
  id: string;
  inboxId: string;
  remoteId: string | null;
  folder: MessageFolder;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  otpCode: string | null;
  threadId: string | null;
}

export interface MessageDetail extends MessageSummary {
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  attachments: AttachmentMeta[];
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface SessionInfo {
  token: string;
  expiresInSeconds: number;
  requireApiKey: boolean;
}

export interface ApiKeyPublic {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export interface ActivityEntry {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface HealthResponse {
  status: string;
  timestamp: string;
  uptimeSeconds: number;
  components: Record<string, { status: string; detail: string }>;
}
