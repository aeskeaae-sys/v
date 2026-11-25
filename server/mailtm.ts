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

export async function provisionLiveMxAccount(options?: {
  preferredLocalPart?: string;
  preferredDomain?: string;
}): Promise<ProvisionedLiveAccount> {
  const domains = await fetchLiveMxDomains();
  if (domains.length === 0) {
    throw new Error('No active Mail.tm domains available.');
  }
  const chosenDomain =
    options?.preferredDomain && domains.includes(options.preferredDomain.toLowerCase())
      ? options.preferredDomain.toLowerCase()
      : domains[0];
  const cleanPrefix = (options?.preferredLocalPart || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 32);
  const localPart =
    cleanPrefix || `fm-${crypto.randomBytes(4).toString('hex').slice(0, 7)}`;
  const address = `${localPart}@${chosenDomain}`;
  const remotePassword = crypto.randomBytes(16).toString('hex');
  const accRes = await fetch(`${MAILTM_BASE}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password: remotePassword }),
    signal: AbortSignal.timeout(10000),
  });
  if (!accRes.ok) {
    const errBody = await accRes.text().catch(() => '');
    throw new Error(`Failed to provision live mailbox (${accRes.status}): ${errBody.slice(0, 200)}`);
  }
  const accJson = (await accRes.json()) as { id?: string };
  if (!accJson.id) {
    throw new Error('Live mail provider did not return account id.');
  }
  const remoteToken = await fetchMailTmToken(address, remotePassword);
  return {
    address,
    localPart,
    domain: chosenDomain,
    remoteAccountId: accJson.id,
    remotePassword,
    remoteToken,
  };
}

export async function deleteLiveMxAccount(credentials: LiveMxCredentials): Promise<void> {
  try {
    await fetch(`${MAILTM_BASE}/accounts/${encodeURIComponent(credentials.remoteAccountId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${credentials.remoteToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // best-effort cleanup
  }
}

export async function deleteLiveMxMessage(
  credentials: LiveMxCredentials,
  remoteMessageId: string,
): Promise<void> {
  try {
    await fetch(`${MAILTM_BASE}/messages/${encodeURIComponent(remoteMessageId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${credentials.remoteToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // best-effort
  }
}

export async function fetchNewLiveMxMessages(
  address: string,
  credentials: LiveMxCredentials,
  knownRemoteIds: Set<string>,
): Promise<{ messages: IngestEmailPayload[]; refreshedToken?: string }> {
  let activeToken = credentials.remoteToken;
  let refreshedToken: string | undefined;

  let listRes = await fetch(`${MAILTM_BASE}/messages`, {
    headers: { Authorization: `Bearer ${activeToken}` },
    signal: AbortSignal.timeout(8000),
  });

  if (listRes.status === 401 && credentials.remotePassword) {
    activeToken = await fetchMailTmToken(address, credentials.remotePassword);
    refreshedToken = activeToken;
    listRes = await fetch(`${MAILTM_BASE}/messages`, {
      headers: { Authorization: `Bearer ${activeToken}` },
      signal: AbortSignal.timeout(8000),
    });
  }

  if (!listRes.ok) {
    return { messages: [], refreshedToken };
  }

  const listJson = (await listRes.json()) as { 'hydra:member'?: MailTmMessageSummary[] };
  const summaries = listJson['hydra:member'] ?? [];
  const newSummaries = summaries.filter((m) => m.id && !knownRemoteIds.has(m.id));
  if (newSummaries.length === 0) {
    return { messages: [], refreshedToken };
  }

  const payloads: IngestEmailPayload[] = [];
  for (const summary of newSummaries) {
    try {
      const detailRes = await fetch(
        `${MAILTM_BASE}/messages/${encodeURIComponent(summary.id)}`,
        {
          headers: { Authorization: `Bearer ${activeToken}` },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!detailRes.ok) continue;
      const detail = (await detailRes.json()) as MailTmMessageDetail;
      const htmlContent = Array.isArray(detail.html)
        ? detail.html.join('\n')
        : typeof detail.html === 'string'
          ? detail.html
          : '';
      const attachments: EmailAttachment[] = (detail.attachments ?? []).map((a) => ({
        filename: a.filename || 'attachment',
        contentType: a.contentType || 'application/octet-stream',
        size: Number(a.size || 0),
      }));

      payloads.push({
        to: address,
        from: detail.from?.address || summary.from?.address || 'unknown@sender.net',
        fromName: detail.from?.name || summary.from?.name || undefined,
        subject: detail.subject || summary.subject || '(No Subject)',
        text: detail.text || summary.intro || '',
        html: htmlContent,
        attachments,
        headers: {
          ...(detail.msgid ? { 'Message-ID': detail.msgid } : {}),
          'X-Mail-Transport': 'Live-MX',
        },
        source: 'live-mx',
        remoteId: detail.id || summary.id,
        receivedAt: detail.createdAt || summary.createdAt || new Date().toISOString(),
      });
    } catch {
      // Skip transient message fetch failure; next poll retries
    }
  }

  return { messages: payloads, refreshedToken };
}
