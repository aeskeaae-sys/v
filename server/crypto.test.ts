import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SecretCipher,
  redactOtpCode,
  redactSensitiveUrl,
  signWebhookPayload,
  verifyWebhookSignature,
} from './crypto.ts';

test('SecretCipher encrypts, persists key file, decrypts, and rejects tampered ciphertext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybox-cipher-'));
  try {
    const cipher = new SecretCipher(dir);
    const encrypted = cipher.encrypt('jwt_live_mx_token_9988');
    assert.ok(encrypted.startsWith('v1:'));
    assert.equal(encrypted.includes('jwt_live_mx_token_9988'), false);

    const cipher2 = new SecretCipher(dir);
    assert.equal(cipher2.decrypt(encrypted), 'jwt_live_mx_token_9988');

    assert.equal(cipher.decrypt('plain-legacy'), 'plain-legacy');

    const parts = encrypted.split(':');
    const mutated = `${parts[0]}:${parts[1]}:${parts[2]}:${'AA' + parts[3].slice(2)}`;
    assert.equal(cipher.decrypt(mutated), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HMAC webhook signature signs, verifies, and rejects forged or expired payloads', () => {
  const secret = 'whsec_test_1234567890';
  const body = JSON.stringify({ event: 'email:received', id: 'msg_1' });
  const nowSec = 1_800_000_000;
  const sig = signWebhookPayload(secret, nowSec, body);

  assert.equal(verifyWebhookSignature(secret, sig, body, 300, nowSec + 10).ok, true);
  assert.equal(verifyWebhookSignature(secret, sig, '{"tampered":true}', 300, nowSec + 10).ok, false);
  assert.equal(verifyWebhookSignature(secret, sig, body, 300, nowSec + 600).ok, false);
  assert.equal(verifyWebhookSignature(secret, undefined, body, 300, nowSec).ok, false);
});

test('redacts OTP codes and sensitive webhook URLs safely for audit logs', () => {
  assert.equal(redactOtpCode('482910'), '48****');
  assert.equal(
    redactSensitiveUrl('https://hooks.example.com/events?token=secret123&env=prod'),
    'https://hooks.example.com/events?token=%5BREDACTED%5D&env=prod',
  );
});
