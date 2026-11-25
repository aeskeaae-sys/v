import crypto from 'node:crypto';
import type { EmailAttachment, IngestEmailPayload } from '../shared/types.ts';

const MAILTM_BASE = 'https://api.mail.tm';

interface MailTmDomainItem {
  id: string;
  domain: string;
  isActive: boolean;
  isPrivate: boolean;
}

interface MailTmMessageSummary {
  id: string;
  from?: { address?: string; name?: string };
  to?: { address?: string; name?: string }[];
  subject?: string;
  intro?: string;
  createdAt?: string;
}

interface MailTmMessageDetail extends MailTmMessageSummary {
  text?: string;
  html?: string[] | string;
  attachments?: {
    filename?: string;
    contentType?: string;
    size?: number;
  }[];
  msgid?: string;
}

export interface LiveMxCredentials {
  remoteAccountId: string;
  remotePassword: string;
  remoteToken: string;
}

export interface ProvisionedLiveAccount extends LiveMxCredentials {
  address: string;
  localPart: string;
  domain: string;
}

let cachedDomains: { domains: string[]; fetchedAt: number } | null = null;

export async function fetchLiveMxDomains(forceRefresh = false): Promise<string[]> {
  const now = Date.now();
  if (!forceRefresh && cachedDomains && now - cachedDomains.fetchedAt < 5 * 60 * 1000) {
    return cachedDomains.domains;
  }

  try {
    const res = await fetch(`${MAILTM_BASE}/domains`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return cachedDomains?.domains ?? [];
    }
    const json = (await res.json()) as { 'hydra:member'?: MailTmDomainItem[] };
    const domains = (json['hydra:member'] ?? [])
      .filter((d) => d.isActive && !d.isPrivate && typeof d.domain === 'string')
      .map((d) => d.domain.toLowerCase());

    if (domains.length > 0) {
      cachedDomains = { domains, fetchedAt: now };
    }
    return domains;
  } catch {
    return cachedDomains?.domains ?? [];
  }
}

export async function fetchMailTmToken(address: string, password: string): Promise<string> {
  const res = await fetch(`${MAILTM_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Failed to authenticate live mailbox (${res.status}).`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) {
    throw new Error('Live mail provider did not return an auth token.');
  }
  return json.token;
}
