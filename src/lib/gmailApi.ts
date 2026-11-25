export class GmailAuthExpiredError extends Error {
  public readonly insufficientScope: boolean;

  constructor(
    message = 'สิทธิ์การเข้าถึง Gmail หมดอายุหรือไม่เพียงพอ กรุณาเชื่อมต่อบัญชี Google และติ๊กอนุญาตการอ่าน Gmail ใหม่อีกครั้ง',
    insufficientScope = false,
  ) {
    super(message);
    this.name = 'GmailAuthExpiredError';
    this.insufficientScope = insufficientScope;
  }
}

export interface ImportedGmailMessage {
  remoteId: string;
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  source: 'gmail';
  receivedAt: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  headers?: GmailHeader[];
  parts?: GmailMessagePart[];
}

interface GmailMessageResponse {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailMessagePart;
}

function decodeBase64Url(data?: string): string {
  if (!data) return '';
  try {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (base64.length % 4)) % 4;
    const padded = base64 + '='.repeat(padLength);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function parseSender(rawFrom: string): { email: string; name?: string } {
  const trimmed = rawFrom.trim();
  const match = trimmed.match(/^(?:"?([^"]*)"?\s*)?<([^>\s]+@[^>\s]+)>$/);
  if (match) {
    const name = match[1]?.trim() || undefined;
    const email = match[2].trim();
    return { email, name };
  }
  return { email: trimmed || 'unknown@gmail.com' };
}

function extractBodyParts(part?: GmailMessagePart): { text: string; html: string } {
  let text = '';
  let html = '';
  if (!part) return { text, html };

  const mime = (part.mimeType || '').toLowerCase();
  if (mime === 'text/plain' && part.body?.data) {
    text = decodeBase64Url(part.body.data);
  } else if (mime === 'text/html' && part.body?.data) {
    html = decodeBase64Url(part.body.data);
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const sub = extractBodyParts(child);
      if (!text && sub.text) text = sub.text;
      if (!html && sub.html) html = sub.html;
    }
  }

  if (!text && !html && part.body?.data) {
    const fallback = decodeBase64Url(part.body.data);
    if (mime.includes('html')) {
      html = fallback;
    } else {
      text = fallback;
    }
  }

  return { text, html };
}

function headerLookup(headers: GmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const h of headers) {
    const key = h.name?.trim();
    if (!key) continue;
    out[key.toLowerCase()] = h.value ?? '';
  }
  return out;
}

export async function fetchGmailMessagesForAlias(
  accessToken: string,
  aliasAddress: string,
  maxResults = 15,
): Promise<ImportedGmailMessage[]> {
  if (!accessToken) {
    throw new GmailAuthExpiredError();
  }

  const query = `deliveredto:"${aliasAddress}" OR to:"${aliasAddress}"`;
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
    query,
  )}&maxResults=${Math.min(Math.max(maxResults, 1), 30)}`;

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (listRes.status === 401) {
    throw new GmailAuthExpiredError();
  }
  if (!listRes.ok) {
    const errBody = await listRes.json().catch(() => null);
    const msg =
      (errBody as { error?: { message?: string } } | null)?.error?.message ||
      `Gmail API error (${listRes.status})`;
    if (listRes.status === 403 && /insufficient|scope|permission/i.test(msg)) {
      throw new GmailAuthExpiredError(
        'ยังไม่ได้รับสิทธิ์อ่านอีเมลจาก Google (insufficient authentication scopes) — กรุณาเชื่อมต่อบัญชี Gmail และติ๊กถูกอนุญาตสิทธิ์อ่านข้อความ Gmail ในหน้าต่างของ Google',
        true,
      );
    }
    throw new Error(msg);
  }

  const listData = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const refs = listData.messages ?? [];
  if (refs.length === 0) return [];

  const detailed = await Promise.all(
    refs.map(async (ref): Promise<ImportedGmailMessage | null> => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (msgRes.status === 401) {
        throw new GmailAuthExpiredError();
      }
      if (msgRes.status === 403) {
        throw new GmailAuthExpiredError(
          'ยังไม่ได้รับสิทธิ์อ่านเนื้อหาอีเมล Gmail (insufficient authentication scopes) — กรุณาเชื่อมต่อบัญชี Gmail และติ๊กถูกอนุญาตสิทธิ์อ่านอีเมลใหม่อีกครั้ง',
          true,
        );
      }
      if (!msgRes.ok) return null;

      const msgData = (await msgRes.json()) as GmailMessageResponse;
      const hdrs = headerLookup(msgData.payload?.headers);
      const { email: from, name: fromName } = parseSender(hdrs.from || '');
      const subject = hdrs.subject || '(No Subject)';
      const { text, html } = extractBodyParts(msgData.payload);

      let receivedAt = new Date().toISOString();
      if (msgData.internalDate && /^\d+$/.test(msgData.internalDate)) {
        receivedAt = new Date(Number(msgData.internalDate)).toISOString();
      } else if (hdrs.date) {
        const parsedDate = Date.parse(hdrs.date);
        if (!Number.isNaN(parsedDate)) {
          receivedAt = new Date(parsedDate).toISOString();
        }
      }

      const preservedHeaders: Record<string, string> = {};
      for (const k of ['from', 'to', 'delivered-to', 'subject', 'date', 'message-id']) {
        if (hdrs[k]) preservedHeaders[k] = hdrs[k];
      }

      return {
        remoteId: `gmail_${msgData.id}`,
        from,
        fromName,
        subject,
        text: text || msgData.snippet || '',
        html,
        headers: preservedHeaders,
        source: 'gmail',
        receivedAt,
      };
    }),
  );

  return detailed.filter((item): item is ImportedGmailMessage => item !== null);
}
