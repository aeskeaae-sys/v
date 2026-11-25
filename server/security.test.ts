import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createAppInstance } from '../server.ts';
import { hashSessionToken } from './auth.ts';
import { validateProductionEnv } from './env.ts';
import type { ApiKeyScope } from '../shared/types.ts';

async function startInstance(options: { dbPath?: string | null } = {}) {
  const instance = await createAppInstance({
    dbPath: options.dbPath === undefined ? null : options.dbPath,
    legacyJsonPath: null,
    skipStarterInbox: true,
    smtpPort: 0,
  });
  const httpServer: Server = await new Promise((resolve) => {
    const srv = instance.app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const addr = httpServer.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return {
    instance,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await instance.close();
    },
  };
}

async function authenticatedToken(
  baseUrl: string,
  instance: Awaited<ReturnType<typeof createAppInstance>>,
) {
  const { plaintextKey } = await instance.store.createApiKey(
    'security-test-bootstrap',
    ['read', 'write', 'webhooks', 'admin'] as ApiKeyScope[],
    2000,
  );
  const res = await fetch(`${baseUrl}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: plaintextKey }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}

test('security: anonymous session bootstrap is read-only and rejects write/admin routes', async () => {
  const srv = await startInstance();
  try {
    const sessionRes = await fetch(`${srv.baseUrl}/api/v1/session`, { method: 'POST' });
    assert.equal(sessionRes.status, 200);
    const session = (await sessionRes.json()) as { token: string; scopes: string[] };
    assert.deepEqual(session.scopes, ['read']);
    const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };

    assert.equal((await fetch(`${srv.baseUrl}/api/v1/inboxes`, { headers })).status, 200);

    const write = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'webhook', domain: 'relaybox.dev' }),
    });
    assert.equal(write.status, 403);
    assert.equal(((await write.json()) as { code: string }).code, 'INSUFFICIENT_SCOPE');

    const admin = await fetch(`${srv.baseUrl}/api/v1/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ requireApiKey: true }),
    });
    assert.equal(admin.status, 403);
  } finally {
    await srv.close();
  }
});

test('security: invalid session credentials are rejected and logout revokes tokens', async () => {
  const srv = await startInstance();
  try {
    const badPasscode = await fetch(`${srv.baseUrl}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'definitely-wrong' }),
    });
    assert.equal(badPasscode.status, 401);

    const badKey = await fetch(`${srv.baseUrl}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'fm_live_invalid' }),
    });
    assert.equal(badKey.status, 401);

    const token = await authenticatedToken(srv.baseUrl, srv.instance);
    const logout = await fetch(`${srv.baseUrl}/api/v1/session/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal((await logout.json() as { revoked: boolean }).revoked, true);

    const afterLogout = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await srv.close();
  }
});

test('security: expired sessions are rejected', async () => {
  const srv = await startInstance();
  try {
    const token = await authenticatedToken(srv.baseUrl, srv.instance);
    await srv.instance.store.database.client
      .prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(new Date(Date.now() - 1000).toISOString(), hashSessionToken(token));

    const res = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test('security: CORS allowlist and state-changing origin guard are enforced', async () => {
  const srv = await startInstance();
  try {
    const badPreflight = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(badPreflight.status, 403);

    const goodPreflight = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(goodPreflight.status, 204);
    assert.equal(goodPreflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    const token = await authenticatedToken(srv.baseUrl, srv.instance);
    const crossSiteWrite = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'webhook', domain: 'relaybox.dev' }),
    });
    assert.equal(crossSiteWrite.status, 403);
    assert.equal(((await crossSiteWrite.json()) as { code: string }).code, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await srv.close();
  }
});

test('security: sessions and rate-limit counters are shared across instances on one database', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybox-shared-'));
  const dbPath = path.join(tmpDir, 'shared.db');
  const a = await startInstance({ dbPath });
  const b = await startInstance({ dbPath });
  try {
    const token = await authenticatedToken(a.baseUrl, a.instance);
    const fromB = await fetch(`${b.baseUrl}/api/v1/inboxes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(fromB.status, 200);

    const key = await a.instance.store.createApiKey('shared-rate-key', ['read'] as ApiKeyScope[], 10);
    let lastStatus = 200;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${b.baseUrl}/api/v1/inboxes`, {
        headers: { Authorization: `Bearer ${key.plaintextKey}` },
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  } finally {
    await a.close();
    await b.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('security: production environment validation blocks default secrets', () => {
  const valid = validateProductionEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/relaybox',
    RELAYBOX_ENCRYPTION_KEY: 'x'.repeat(48),
    ADMIN_PASSCODE: 'strong-admin-passcode-2026',
    WEBHOOK_INBOUND_SECRET: 'webhook-secret-long-enough',
    REQUIRE_API_KEY: 'true',
    ALLOWED_ORIGINS: 'https://app.example.com',
    VITE_API_BASE_URL: 'https://api.example.com',
  });
  assert.equal(valid.ok, true);

  const invalid = validateProductionEnv({
    NODE_ENV: 'production',
    REQUIRE_API_KEY: 'false',
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((e) => e.includes('RELAYBOX_ENCRYPTION_KEY')));
  assert.ok(invalid.errors.some((e) => e.includes('ADMIN_PASSCODE')));
  assert.ok(invalid.errors.some((e) => e.includes('WEBHOOK_INBOUND_SECRET')));
  assert.ok(invalid.errors.some((e) => e.includes('REQUIRE_API_KEY')));
});
