import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import type {
  EmailAttachment,
  ExtractedArtifacts,
  ExtractedLink,
} from '../shared/types.ts';

export interface ParsedEmailAddress {
  localPart: string;
  domain: string;
  full: string;
  displayName?: string;
}

const EMAIL_RE = /^([a-z0-9._+-]{1,64})@([a-z0-9.-]+\.[a-z]{2,})$/;

export function normalizeEmailAddress(raw: string): ParsedEmailAddress | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let displayName: string | undefined;
  let addrCandidate = trimmed;

  const angleMatch = trimmed.match(/^(?:"?([^"<>]+?)"?\s*)?<([^<>]+)>$/);
  if (angleMatch) {
    displayName = angleMatch[1]?.trim() || undefined;
    addrCandidate = angleMatch[2].trim();
  }

  const lower = addrCandidate.toLowerCase();
  const match = lower.match(EMAIL_RE);
  if (!match) return null;

  const [, localPart, domain] = match;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return null;
  }

  return {
    localPart,
    domain,
    full: `${localPart}@${domain}`,
    displayName,
  };
}

export function generateRandomLocalPart(prefix = 'qa'): string {
  const safePrefix =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 16) || 'qa';
  const suffix = crypto.randomBytes(4).toString('hex').slice(0, 6);
  return `${safePrefix}-${suffix}`;
}

export function stripHtmlToText(html: string): string {
  if (!html) return '';
  let text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function buildSnippet(text: string, html?: string, maxLen = 140): string {
  const source = (text && text.trim()) || stripHtmlToText(html || '');
  const singleLine = source.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 1).trimEnd()}…`;
}

function isLikelyFalsePositiveNumber(
  candidate: string,
  fullText: string,
  index: number,
): boolean {
  // Ignore standalone 4-digit calendar years (1970-2099) unless immediately preceded by strong OTP/PIN keyword
  if (/^(19\d\d|20\d\d)$/.test(candidate)) {
    const before = fullText.slice(Math.max(0, index - 32), index).toLowerCase();
    if (!/\b(?:otp|pin|code|passcode|รหัส)\s*(?:is|:|=)?\s*$/.test(before)) {
      return true;
    }
  }

  // Ignore currency amounts like $4900 or 1200.00
  const prevChar = index > 0 ? fullText[index - 1] : '';
  const nextChar = fullText[index + candidate.length] ?? '';
  if (prevChar === '$' || prevChar === '€' || prevChar === '฿' || prevChar === '#') {
    return true;
  }
  if (nextChar === '.' && /^\d{2}/.test(fullText.slice(index + candidate.length + 1))) {
    return true;
  }
  // Ignore phone-like / date-like sequences e.g. 2026-11-24 or +1-555-0192
  if (prevChar === '-' || nextChar === '-') {
    if (!/^\d{3}-\d{3}$/.test(candidate)) {
      return true;
    }
  }
  return false;
}

export function extractOtpCodes(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  const seen = new Set<string>();

  const addCode = (raw: string) => {
    const cleaned = raw.trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    results.push(cleaned);
  };

  // 1. Contextual matches (English + Thai): supports 4, 5, 6, 8 digits, 3-3 hyphenated, or uppercase alphanumeric OTP (e.g. A7K9P2, G-492810)
  const contextualRe =
    /(?:code|otp|pin|passcode|token|verify|verification|security|one-time|2fa|mfa|รหัสยืนยัน|รหัส\s*otp|รหัสผ่านชั่วคราว)\b[^\n\r]{0,36}?\b([0-9]{4,8}|[0-9]{3}-[0-9]{3}|[A-Z0-9]{5,8})\b/gi;
  for (const match of text.matchAll(contextualRe)) {
    const candidate = match[1];
    const matchIndex = match.index ?? 0;
    const candIdx = text.indexOf(candidate, matchIndex);
    // Avoid matching lowercase English words
    if (/[a-z]/.test(candidate)) continue;
    // Reject pure alphabetic words like "VERIFY" or "MINUTE"
    const digitCount = (candidate.match(/\d/g) || []).length;
    if (digitCount < 2) continue;
    // Reject 7-digit numbers unless hyphenated (rule allows 4, 5, 6, 8 digits & alphanumeric)
    if (/^\d{7}$/.test(candidate)) continue;
    if (isLikelyFalsePositiveNumber(candidate, text, candIdx >= 0 ? candIdx : matchIndex)) {
      continue;
    }
    addCode(candidate);
  }

  // 2. Standalone 6-digit, 8-digit, or 3-3 digit codes on their own line or surrounded by whitespace
  const standaloneRe = /(?:^|\s)([0-9]{6}|[0-9]{8}|[0-9]{3}-[0-9]{3})(?=$|[\s.,!?;:])/gm;
  for (const match of text.matchAll(standaloneRe)) {
    const candidate = match[1];
    const matchIndex = (match.index ?? 0) + (match[0].length - candidate.length);
    if (isLikelyFalsePositiveNumber(candidate, text, matchIndex)) continue;
    addCode(candidate);
  }

  // 3. Fallback 6 or 8 digit standalone codes not part of hyphenated/hashed IDs (like INV-2026-0842)
  if (results.length === 0) {
    const numericRe = /(?<![-#\d])([0-9]{6}|[0-9]{8})(?![-#\d])/g;
    for (const match of text.matchAll(numericRe)) {
      const candidate = match[1];
      if (isLikelyFalsePositiveNumber(candidate, text, match.index ?? 0)) continue;
      addCode(candidate);
    }
  }

  return results;
}

function classifyLink(url: string, label?: string): ExtractedLink['kind'] {
  const haystack = `${url} ${label || ''}`.toLowerCase();
  if (/reset|forgot|recovery|password|รีเซ็ต/.test(haystack)) return 'reset';
  if (/verify|confirm|activate|validate|ยืนยัน/.test(haystack)) return 'verification';
  if (/magic|sign-in|signin|login|sso|auth|เข้าสู่ระบบ/.test(haystack)) return 'magic-link';
  return 'general';
}

function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function extractLinks(text: string, html?: string): ExtractedLink[] {
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  const pushLink = (rawUrl: string, label?: string) => {
    const decoded = rawUrl.replace(/&amp;/gi, '&');
    const trimmed = decoded.replace(/[),.;]+$/, '').trim();
    if (!isSafeHttpUrl(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    const cleanLabel = label ? stripHtmlToText(label).trim() : undefined;
    links.push({
      url: trimmed,
      label: cleanLabel || undefined,
      kind: classifyLink(trimmed, cleanLabel),
    });
  };

  if (html) {
    const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(anchorRe)) {
      pushLink(match[1], match[2]);
    }
  }

  if (text) {
    const urlRe = /https?:\/\/[^\s<>"']+/gi;
    for (const match of text.matchAll(urlRe)) {
      pushLink(match[0]);
    }
  }

  return links;
}

export function extractArtifacts(text: string, html?: string): ExtractedArtifacts {
  const combinedText = [text, html ? stripHtmlToText(html) : ''].filter(Boolean).join('\n');
  const otpCodes = extractOtpCodes(combinedText);
  const links = extractLinks(text, html);

  const actionLink =
    links.find((l) => l.kind !== 'general') ??
    links[0] ??
    null;

  return {
    otpCodes,
    links,
    primaryOtp: otpCodes[0] ?? null,
    primaryActionUrl: actionLink ? actionLink.url : null,
  };
}

export function sanitizeEmailHtmlForSandbox(
  html: string,
  allowRemoteImages = false,
): string {
  const stripped = (html || '')
    // Remove active/scriptable/embedded tags completely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<applet[\s\S]*?<\/applet>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<math[\s\S]*?<\/math>/gi, '')
    .replace(/<(?:frame|frameset|form|input|textarea|select|button)\b[^>]*>/gi, '')
    .replace(/<\/(?:frame|frameset|form|textarea|select|button)>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*(?:refresh|content-security-policy)[^>]*>/gi, '')
    // Strip inline event handlers & srcdoc
    .replace(/\s(?:on[a-z]+|srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Neutralize dangerous protocols in href/src/action/poster
    .replace(
      /(href|src|action|poster)\s*=\s*(?:"\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|[^\s>]*javascript:[^\s>]*)/gi,
      '$1="#"',
    )
    // Neutralize dangerous CSS expressions/imports
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/@import\b/gi, '@blocked')
    // Ensure anchor links open cleanly via <base target="_blank">
    .replace(/(<a\b[^>]*?)\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');

  const imgDirective = allowRemoteImages ? 'https: http: data:' : 'data:';
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgDirective}; font-src 'none'; script-src 'none'; object-src 'none'; connect-src 'none'; form-action 'none';">`;
  const baseTag = `<base target="_blank">`;
  const baseCss = `<style>html,body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background:#ffffff;word-break:break-word;}img{max-width:100%;height:auto;}a{color:#2563eb;cursor:pointer;}</style>`;
  const headInject = `${cspMeta}${baseTag}${baseCss}`;

  if (/<html[\s>]/i.test(stripped)) {
    if (/<head[\s>]/i.test(stripped)) {
      return stripped.replace(/<head([^>]*)>/i, `<head$1>${headInject}`);
    }
    return stripped.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${headInject}</head>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">${headInject}</head><body>${stripped}</body></html>`;
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^0\.0\.0\.0$/,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^\[::1\]$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

export function validateOutboundWebhookUrl(
  rawUrl: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, error: 'Webhook URL cannot be empty.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Only http:// or https:// webhook URLs are allowed.' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(hostname))) {
    return { ok: false, error: 'Private, loopback, or link-local addresses are blocked.' };
  }

  return { ok: true, url: parsed.toString() };
}

function isPrivateResolvedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(normalized))) return true;
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(normalized)) {
    return /^(::1|::|fe[89ab]|fc|fd|ff)/i.test(normalized);
  }
  return true;
}

export async function validateOutboundWebhookTarget(
  rawUrl: string,
  lookup: (hostname: string) => Promise<{ address: string }[]> = (hostname) =>
    dns.promises.lookup(hostname, { all: true }),
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const checked = validateOutboundWebhookUrl(rawUrl);
  if (!checked.ok) return checked;

  const parsed = new URL(checked.url);
  if (net.isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    return isPrivateResolvedAddress(parsed.hostname)
      ? { ok: false, error: 'Webhook target is a private or loopback IP address.' }
      : checked;
  }

  try {
    const addresses = await lookup(parsed.hostname);
    if (!addresses.length) {
      return { ok: false, error: 'Webhook hostname did not resolve.' };
    }
    if (addresses.some((entry) => isPrivateResolvedAddress(entry.address))) {
      return { ok: false, error: 'Webhook hostname resolves to a private or loopback address.' };
    }
  } catch {
    return { ok: false, error: 'Unable to resolve webhook hostname.' };
  }
  return checked;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const BLOCKED_ATTACHMENT_EXT = /\.(exe|bat|cmd|com|msi|scr|pif|vbs|vbe|js|jse|ps1|sh|dll)$/i;

export function sanitizeAttachmentFilename(rawName: string): string {
  const base = rawName.replace(/^.*[/\\]/, '').replace(/\.\./g, '').trim();
  return base.slice(0, 180) || 'attachment.bin';
}

export function validateAttachment(
  att: EmailAttachment,
): { ok: true; sanitized: EmailAttachment } | { ok: false; reason: string } {
  const filename = sanitizeAttachmentFilename(att.filename || 'attachment.bin');
  if (BLOCKED_ATTACHMENT_EXT.test(filename)) {
    return { ok: false, reason: `Executable attachment "${filename}" is blocked.` };
  }
  const size = Number(att.size || 0);
  if (!Number.isFinite(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `Attachment "${filename}" exceeds maximum allowed size (10 MB).` };
  }
  const contentType = (att.contentType || 'application/octet-stream').trim().toLowerCase();
  return {
    ok: true,
    sanitized: {
      filename,
      contentType,
      size,
    },
  };
}

function decodeQuotedPrintable(input: string): string {
  const softBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < softBreaks.length; i++) {
    if (softBreaks[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(softBreaks.slice(i + 1, i + 3))) {
      bytes.push(parseInt(softBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(softBreaks.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeHeaderWord(raw: string): string {
  return raw.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_m, _charset, encoding, data) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(data, 'base64').toString('utf8');
      }
      return decodeQuotedPrintable(data.replace(/_/g, ' '));
    } catch {
      return raw;
    }
  });
}

function parseHeaderBlock(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let lastKey = '';
  for (const line of headerBlock.split('\n')) {
    if (/^[ \t]/.test(line) && lastKey) {
      headers[lastKey] = `${headers[lastKey]} ${decodeHeaderWord(line.trim())}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = decodeHeaderWord(line.slice(colon + 1).trim());
      headers[key] = val;
      lastKey = key;
    }
  }
  return headers;
}

function decodeBodyByEncoding(body: string, encodingHeader?: string): string {
  const enc = (encodingHeader || '').trim().toLowerCase();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  return body;
}

export interface ParsedMimeEmail {
  subject: string;
  from?: string;
  headers: Record<string, string>;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

export function parseMimeRawEmail(raw: string): ParsedMimeEmail {
  const normalized = raw.replace(/\r\n/g, '\n');
  const splitIdx = normalized.indexOf('\n\n');
  const headerBlock = splitIdx >= 0 ? normalized.slice(0, splitIdx) : '';
  const bodyBlock = splitIdx >= 0 ? normalized.slice(splitIdx + 2) : normalized;
  const headers = parseHeaderBlock(headerBlock);

  const getHeader = (name: string): string => {
    const found = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found ? found[1] : '';
  };

  let text = '';
  let html = '';
  const attachments: EmailAttachment[] = [];

  const extractPart = (partHeaders: Record<string, string>, partBody: string) => {
    const getPHeader = (name: string): string => {
      const found = Object.entries(partHeaders).find(
        ([k]) => k.toLowerCase() === name.toLowerCase(),
      );
      return found ? found[1] : '';
    };

    const ct = getPHeader('content-type') || 'text/plain';
    const cte = getPHeader('content-transfer-encoding');
    const disp = getPHeader('content-disposition');

    const boundaryMatch = ct.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
    if (/multipart\//i.test(ct) && boundaryMatch) {
      const boundary = boundaryMatch[1];
      const segments = partBody.split(`--${boundary}`);
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed || trimmed === '--') continue;
        const innerSplit = seg.replace(/^\n/, '').indexOf('\n\n');
        if (innerSplit < 0) continue;
        const subHdr = parseHeaderBlock(seg.replace(/^\n/, '').slice(0, innerSplit));
        const subBody = seg.replace(/^\n/, '').slice(innerSplit + 2);
        extractPart(subHdr, subBody);
      }
      return;
    }

    const filenameMatch =
      disp.match(/filename\s*=\s*"?([^";]+)"?/i) || ct.match(/name\s*=\s*"?([^";]+)"?/i);
    if (/attachment/i.test(disp) || (filenameMatch && !/text\/(?:plain|html)/i.test(ct))) {
      const filename = sanitizeAttachmentFilename(filenameMatch?.[1] || 'attachment.bin');
      const contentType = ct.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
      const decodedSize =
        cte.toLowerCase() === 'base64'
          ? Math.floor((partBody.replace(/\s+/g, '').length * 3) / 4)
          : Buffer.byteLength(partBody, 'utf8');
      const check = validateAttachment({ filename, contentType, size: decodedSize });
      if (check.ok) {
        attachments.push(check.sanitized);
      }
      return;
    }

    const decoded = decodeBodyByEncoding(partBody.trim(), cte);
    if (/text\/html/i.test(ct)) {
      html = html ? `${html}\n${decoded}` : decoded;
    } else if (/text\/plain/i.test(ct)) {
      text = text ? `${text}\n${decoded}` : decoded;
    }
  };

  extractPart(headers, bodyBlock);

  if (!text && html) {
    text = stripHtmlToText(html);
  }

  return {
    subject: getHeader('subject') || '(No Subject)',
    from: getHeader('from') || undefined,
    headers,
    text,
    html,
    attachments,
  };
}

export function classifySpam(input: {
  from: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}): { score: number; isSpam: boolean; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const combined = `${input.subject} ${input.text}`.toLowerCase();

  if (/viagra|cialis|crypto\s*giveaway|claim\s*your\s*prize|lottery\s*winner|nigerian\s*prince/i.test(combined)) {
    score += 45;
    reasons.push('High-risk promotional/scam keywords');
  }
  if (/urgent:\s*account\s*suspended|wire\s*transfer\s*immediately|act\s*now\s*or\s*lose/i.test(combined)) {
    score += 35;
    reasons.push('Phishing urgency pattern');
  }
  if ((input.subject.match(/!/g) || []).length >= 4 || /\$\$\$/.test(input.subject)) {
    score += 20;
    reasons.push('Excessive punctuation or currency bait');
  }
  if (input.html && /<script\b|javascript:/i.test(input.html)) {
    score += 40;
    reasons.push('Active script payload detected');
  }
  if (input.attachments?.some((a) => BLOCKED_ATTACHMENT_EXT.test(a.filename))) {
    score += 65;
    reasons.push('Dangerous executable attachment');
  }

  const spfHeader = Object.entries(input.headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'received-spf' || k.toLowerCase() === 'authentication-results',
  )?.[1];
  if (spfHeader && /\bspf=fail\b|\bdkim=fail\b/i.test(spfHeader)) {
    score += 35;
    reasons.push('SPF/DKIM authentication failure');
  }

  return {
    score: Math.min(100, score),
    isSpam: score >= 60,
    reasons,
  };
}

export function computeThreadId(subject: string, headers?: Record<string, string>): string {
  const hdrs = headers ?? {};
  const refs = Object.entries(hdrs).find(([k]) =>
    /^(in-reply-to|references)$/i.test(k),
  )?.[1];
  if (refs && refs.trim()) {
    const firstMsgId = refs.trim().split(/\s+/)[0];
    if (firstMsgId) {
      return `thr_${crypto.createHash('sha256').update(firstMsgId).digest('hex').slice(0, 12)}`;
    }
  }
  const normalizedSubject = subject
    .replace(/^(?:(?:re|fwd|fw)\s*:\s*)+/gi, '')
    .trim()
    .toLowerCase();
  return `thr_${crypto.createHash('sha256').update(normalizedSubject || 'untitled').digest('hex').slice(0, 12)}`;
}

export function computeMessageContentHash(
  inboxId: string,
  from: string,
  subject: string,
  text: string,
): string {
  const material = `${inboxId}|${from.toLowerCase()}|${subject.trim()}|${text.slice(0, 512)}`;
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}
