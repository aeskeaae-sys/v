import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MASTER_KEY_LEN = 32;

function loadOrCreateMasterKey(keyFileDir?: string | null): Buffer {
  const envKey = process.env.RELAYBOX_ENCRYPTION_KEY?.trim();
  if (envKey) {
    // Derive a deterministic 32-byte key from the provided environment secret
    return crypto.createHash('sha256').update(envKey, 'utf8').digest();
  }

  if (keyFileDir) {
    try {
      fs.mkdirSync(keyFileDir, { recursive: true });
      const keyPath = path.join(keyFileDir, '.master.key');
      if (fs.existsSync(keyPath)) {
        const hex = fs.readFileSync(keyPath, 'utf8').trim();
        const buf = Buffer.from(hex, 'hex');
        if (buf.length === MASTER_KEY_LEN) return buf;
      }
      const generated = crypto.randomBytes(MASTER_KEY_LEN);
      fs.writeFileSync(keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
      return generated;
    } catch {
      // Fallback to in-memory random key if disk is read-only
    }
  }

  return crypto.randomBytes(MASTER_KEY_LEN);
}

export class SecretCipher {
  private readonly key: Buffer;

  constructor(keyFileDir?: string | null) {
    this.key = loadOrCreateMasterKey(keyFileDir);
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext) return '';
    if (!ciphertext.startsWith('v1:')) {
      // Legacy unencrypted value during migration
      return ciphertext;
    }
    const parts = ciphertext.split(':');
    if (parts.length !== 4) return '';
    try {
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const payload = Buffer.from(parts[3], 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      return '';
    }
  }
}

export function signWebhookPayload(
  secret: string,
  timestampSec: number,
  rawBody: string,
): string {
  const signedPayload = `${timestampSec}.${rawBody}`;
  const sigHex = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${timestampSec},v1=${sigHex}`;
}

export function verifyWebhookSignature(
  secret: string,
  signatureHeader: string | undefined,
  rawBody: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (!signatureHeader || !signatureHeader.trim()) {
    return { ok: false, reason: 'Missing X-RelayBox-Signature header.' };
  }

  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, item) => {
    const [k, v] = item.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});

  const ts = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isFinite(ts) || !sig) {
    return { ok: false, reason: 'Malformed signature header. Expected t=<unix>,v1=<hmac>.' };
  }

  if (Math.abs(nowSec - ts) > toleranceSec) {
    return { ok: false, reason: 'Webhook signature timestamp is outside tolerance window.' };
  }

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(sig, 'hex');
  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return { ok: false, reason: 'Invalid webhook HMAC signature.' };
  }

  return { ok: true };
}

export function redactOtpCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length <= 2) return '**';
  return `${trimmed.slice(0, 2)}${'*'.repeat(trimmed.length - 2)}`;
}

export function redactSensitiveUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|ticket|code|auth|key|secret|sig|password/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search ? parsed.search : ''}`;
  } catch {
    return '[URL]';
  }
}
