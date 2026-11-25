import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createAppInstance } from '../server.ts';
import type { ApiKeyScope } from '../shared/types.ts';
import { signWebhookPayload } from './crypto.ts';

async function issueAuthenticatedSession(
  baseUrl: string,
  instance: ReturnType<typeof createAppInstance>,
): Promise<string> {
  const { plaintextKey } = instance.store.createApiKey(
    'integration-session-bootstrap',
    ['read', 'write', 'webhooks', 'admin'] as ApiKeyScope[],
    2000,
  );
  const res = await fetch(`${baseUrl}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: plaintextKey }),
  });
  assert.equal(res.status, 200);
  const { token } = (await res.json()) as { token: string };
  return token;
}

async function startTestServer(extraOpts: {
  dbPath?: string | null;
  inboundSecret?: string;
} = {}) {
  const prevSecret = process.env.WEBHOOK_INBOUND_SECRET;
  if (extraOpts.inboundSecret !== undefined) {
    process.env.WEBHOOK_INBOUND_SECRET = extraOpts.inboundSecret;
  }

  const instance = createAppInstance({
    dbPath: extraOpts.dbPath === undefined ? null : extraOpts.dbPath,
    legacyJsonPath: null,
    skipStarterInbox: true,
    smtpPort: 0,
  });

  const httpServer: Server = await new Promise((resolve) => {
    const srv = instance.app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    instance,
    close: async () => {
      if (prevSecret === undefined) delete process.env.WEBHOOK_INBOUND_SECRET;
      else process.env.WEBHOOK_INBOUND_SECRET = prevSecret;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      instance.close();
    },
  };
}

function sendRawSmtpMail(port: number, from: string, to: string, rawEmail: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let transcript = '';
    let step = 0;

    socket.setTimeout(4000, () => {
      socket.destroy();
      reject(new Error('SMTP client timeout'));
    });

    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      transcript += text;
      if (step === 0 && text.includes('220')) {
        step = 1;
        socket.write('EHLO integration-test.local\r\n');
      } else if (step === 1 && text.includes('250')) {
        step = 2;
        socket.write(`MAIL FROM:<${from}>\r\n`);
      } else if (step === 2 && text.includes('250')) {
        step = 3;
        socket.write(`RCPT TO:<${to}>\r\n`);
      } else if (step === 3 && text.includes('250')) {
        step = 4;
        socket.write('DATA\r\n');
      } else if (step === 4 && text.includes('354')) {
        step = 5;
        socket.write(`${rawEmail}\r\n.\r\n`);
      } else if (step === 5 && text.includes('250')) {
        step = 6;
        socket.write('QUIT\r\n');
      } else if (step === 6 && text.includes('221')) {
        socket.end();
        resolve(transcript);
      }
    });

    socket.on('error', reject);
  });
}

test('integration: full API lifecycle, folders, OTP, SMTP bridge, activity export, and persistence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybox-int-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let srv = await startTestServer({ dbPath });
  try {
    // 1. Health check
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.components.application.status, 'ok');
    assert.equal(health.components.database.status, 'ok');
    assert.ok('X-Content-Type-Options' in Object.fromEntries(healthRes.headers.entries()) || healthRes.headers.get('x-content-type-options') === 'nosniff');

    // 2. Authenticated session (credential-backed, not anonymous)
    const token = await issueAuthenticatedSession(srv.baseUrl, srv.instance);
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 3. Provision webhook/SMTP address
    const createRes = await fetch(`${srv.baseUrl}/api/v1/addresses`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        mode: 'webhook',
        provider: 'smtp',
        prefix: 'qa-e2e',
        domain: 'relaybox.dev',
        ttl: '1h',
        label: 'Integration Inbox',
      }),
    });
    assert.equal(createRes.status, 201);
    const { inbox } = await createRes.json();
    assert.equal(inbox.address, 'qa-e2e@relaybox.dev');

    // 4. Patch address & switch
    const patchRes = await fetch(`${srv.baseUrl}/api/v1/addresses/${inbox.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ label: 'Updated Label', status: 'active' }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).inbox.label, 'Updated Label');

    const switchRes = await fetch(`${srv.baseUrl}/api/v1/addresses/${inbox.id}/switch`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert.equal(switchRes.status, 200);

    // 5. Real SMTP RFC-5321 delivery into ephemeral SMTP port
    const smtpPort = srv.instance.smtpBridge.port;
    assert.ok(smtpPort && smtpPort > 0);
    await sendRawSmtpMail(
      smtpPort,
      'auth@acme.test',
      inbox.address,
      [
        'From: Acme Security <auth@acme.test>',
        `To: ${inbox.address}`,
        'Subject: Your Acme verification code',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Use verification code 842910 within 5 minutes.',
      ].join('\r\n'),
    );

    // 6. Query messages & OTP endpoint
    const msgsRes = await fetch(
      `${srv.baseUrl}/api/v1/inboxes/${inbox.id}/messages?folder=inbox`,
      { headers: authHeaders },
    );
    const msgsJson = await msgsRes.json();
    assert.equal(msgsJson.messages.length, 1);
    const receivedMsg = msgsJson.messages[0];
    assert.equal(receivedMsg.extracted.primaryOtp, '842910');

    const otpRes = await fetch(`${srv.baseUrl}/api/v1/otp?inboxId=${inbox.id}`, {
      headers: authHeaders,
    });
    const otpJson = await otpRes.json();
    assert.equal(otpJson.items.length, 1);
    assert.deepEqual(otpJson.items[0].otpCodes, ['842910']);

    // 7. Compose draft & internal send
    const draftRes = await fetch(`${srv.baseUrl}/api/v1/messages/send`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        inboxId: inbox.id,
        to: 'peer@relaybox.dev',
        subject: 'Draft Note',
        text: 'Draft body',
        mode: 'drafts',
      }),
    });
    assert.equal(draftRes.status, 201);
    const { message: draftMsg } = await draftRes.json();
    assert.equal(draftMsg.folder, 'drafts');

    // 8. Soft-delete to trash, restore, then permanent delete
    const delRes = await fetch(`${srv.baseUrl}/api/v1/messages/${receivedMsg.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.equal(delRes.status, 200);
    const trashedRes = await fetch(`${srv.baseUrl}/api/v1/messages/${receivedMsg.id}`, {
      headers: authHeaders,
    });
    assert.equal((await trashedRes.json()).message.folder, 'trash');

    const restoreRes = await fetch(
      `${srv.baseUrl}/api/v1/messages/${receivedMsg.id}/restore`,
      { method: 'POST', headers: authHeaders },
    );
    assert.equal((await restoreRes.json()).message.folder, 'inbox');

    // 9. SMTP connection tester against local bridge
    const smtpTestRes = await fetch(`${srv.baseUrl}/api/v1/smtp/test`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ host: '127.0.0.1', port: smtpPort }),
    });
    assert.equal(smtpTestRes.status, 200);
    assert.equal((await smtpTestRes.json()).ok, true);

    // 10. Activity export CSV (ensure no raw OTP leaked)
    const csvRes = await fetch(`${srv.baseUrl}/api/v1/activity/export?format=csv`, {
      headers: authHeaders,
    });
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('inbox:created'));
    assert.equal(csvText.includes('842910'), false);

    // 11. Restart against same SQLite DB file and confirm persistence
    await srv.close();
    srv = await startTestServer({ dbPath });
    const session2Token = await issueAuthenticatedSession(srv.baseUrl, srv.instance);
    const listAfterRestart = await (
      await fetch(`${srv.baseUrl}/api/v1/addresses`, {
        headers: { Authorization: `Bearer ${session2Token}` },
      })
    ).json();
    assert.equal(listAfterRestart.inboxes.length, 1);
    assert.equal(listAfterRestart.inboxes[0].address, 'qa-e2e@relaybox.dev');
    assert.equal(listAfterRestart.inboxes[0].messageCount, 1);

    const persistedAll = await (
      await fetch(`${srv.baseUrl}/api/v1/inboxes/${inbox.id}/messages?folder=all`, {
        headers: { Authorization: `Bearer ${session2Token}` },
      })
    ).json();
    assert.equal(persistedAll.messages.length, 2);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('integration: API key scopes, rate limits, HMAC inbound verification, and replay deduplication', async () => {
  const srv = await startTestServer({ inboundSecret: 'super-secret-hook-key' });
  try {
    const sessionToken = await issueAuthenticatedSession(srv.baseUrl, srv.instance);
    const adminHeaders = {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    };

    // Enable strict auth & issue read-only scoped key (minimum clamped rate limit is 10/min)
    await fetch(`${srv.baseUrl}/api/v1/settings`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ requireApiKey: true }),
    });

    const keyRes = await fetch(`${srv.baseUrl}/api/v1/keys`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'ReadOnly Key',
        scopes: ['read'],
        rateLimitPerMin: 10,
      }),
    });
    const { plaintextKey: readKey } = await keyRes.json();

    // Missing auth -> 401
    const unauthRes = await fetch(`${srv.baseUrl}/api/v1/inboxes`);
    assert.equal(unauthRes.status, 401);

    // 1st req: Read-only key cannot POST /api/v1/inboxes -> 403 INSUFFICIENT_SCOPE
    const forbiddenRes = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'webhook', domain: 'relaybox.dev' }),
    });
    assert.equal(forbiddenRes.status, 403);

    // Requests 2..10 succeed, 11th returns 429 RATE_LIMITED
    for (let i = 0; i < 9; i++) {
      const ok = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      assert.equal(ok.status, 200);
    }
    const rateLimited = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      headers: { Authorization: `Bearer ${readKey}` },
    });
    assert.equal(rateLimited.status, 429);

    // Issue webhooks-scoped key & test HMAC + replay deduplication
    const hookKeyRes = await fetch(`${srv.baseUrl}/api/v1/keys`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Webhook Key', scopes: ['webhooks', 'read'], rateLimitPerMin: 60 }),
    });
    const { plaintextKey: hookKey } = await hookKeyRes.json();

    const rawBody = JSON.stringify({
      to: 'hooked@relaybox.dev',
      from: 'sender@app.test',
      subject: 'HMAC Signed Event',
      text: 'Your code is 112233',
      autoCreateInbox: true,
    });

    // Forged signature rejected with 401
    const forgedRes = await fetch(`${srv.baseUrl}/api/v1/inbound`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hookKey}`,
        'Content-Type': 'application/json',
        'X-RelayBox-Signature': 't=1700000000,v1=deadbeef',
        'X-Event-Id': 'evt-unique-1',
      },
      body: rawBody,
    });
    assert.equal(forgedRes.status, 401);

    // Valid HMAC accepted (201)
    const nowSec = Math.floor(Date.now() / 1000);
    const validSig = signWebhookPayload('super-secret-hook-key', nowSec, rawBody);
    const okRes = await fetch(`${srv.baseUrl}/api/v1/inbound`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hookKey}`,
        'Content-Type': 'application/json',
        'X-RelayBox-Signature': validSig,
        'X-Event-Id': 'evt-unique-1',
      },
      body: rawBody,
    });
    assert.equal(okRes.status, 201);

    // Duplicate X-Event-Id deduplicated (200 duplicate: true)
    const dupRes = await fetch(`${srv.baseUrl}/api/v1/inbound`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hookKey}`,
        'Content-Type': 'application/json',
        'X-RelayBox-Signature': validSig,
        'X-Event-Id': 'evt-unique-1',
      },
      body: rawBody,
    });
    assert.equal(dupRes.status, 200);
    assert.equal((await dupRes.json()).duplicate, true);
  } finally {
    await srv.close();
  }
});

test('integration: webhook registry CRUD, SSRF block, event filter update, and test endpoint', async () => {
  const srv = await startTestServer();
  try {
    const sessionToken = await issueAuthenticatedSession(srv.baseUrl, srv.instance);
    const headers = {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    };

    // Private loopback webhook URL rejected by SSRF guard
    const ssrfRes = await fetch(`${srv.baseUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/hook' }),
    });
    assert.equal(ssrfRes.status, 400);

    // Public HTTPS webhook accepted with secret + event filters
    const createRes = await fetch(`${srv.baseUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: 'https://hooks.example.com/relaybox-automation',
        events: ['email.received', 'otp.detected'],
      }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.ok(created.signingSecret.startsWith('whsec_'));
    assert.equal(created.webhook.enabled, true);
    assert.deepEqual(created.webhook.events, ['email.received', 'otp.detected']);

    // PATCH toggle enabled=false & events=['otp.detected']
    const patchRes = await fetch(`${srv.baseUrl}/api/v1/webhooks/${created.webhook.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false, events: ['otp.detected'] }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.webhook.enabled, false);
    assert.deepEqual(patched.webhook.events, ['otp.detected']);

    // Test nonexistent webhook -> 404
    const missingTest = await fetch(`${srv.baseUrl}/api/v1/webhooks/whk_missing/test`, {
      method: 'POST',
      headers,
    });
    assert.equal(missingTest.status, 404);

    // Delete registered webhook
    const delRes = await fetch(`${srv.baseUrl}/api/v1/webhooks/${created.webhook.id}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted, true);
  } finally {
    await srv.close();
  }
});

test('integration: Gmail & Outlook alias creation, message import, and separated /api/admin auth & management', async () => {
  const srv = await startTestServer();
  try {
    const uiToken = await issueAuthenticatedSession(srv.baseUrl, srv.instance);
    const uiHeaders = {
      Authorization: `Bearer ${uiToken}`,
      'Content-Type': 'application/json',
    };

    // Create Gmail Alias & import real message payload
    const gmailCreate = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'POST',
      headers: uiHeaders,
      body: JSON.stringify({
        mode: 'alias',
        provider: 'gmail-alias',
        baseEmail: 'tester@gmail.com',
        strategy: 'plus',
        tag: 'github',
      }),
    });
    assert.equal(gmailCreate.status, 201);
    const { inbox: gmailInbox } = await gmailCreate.json();
    assert.equal(gmailInbox.address, 'tester+github@gmail.com');

    const importRes = await fetch(`${srv.baseUrl}/api/v1/inboxes/${gmailInbox.id}/import-messages`, {
      method: 'POST',
      headers: uiHeaders,
      body: JSON.stringify({
        messages: [
          {
            remoteId: 'gmail_msg_1',
            from: 'noreply@github.com',
            subject: 'GitHub OTP',
            text: 'Your code is 441920.',
            source: 'gmail',
          },
        ],
      }),
    });
    assert.equal(importRes.status, 200);
    const imported = await importRes.json();
    assert.equal(imported.newMessages, 1);
    assert.equal(imported.messages[0].extracted.primaryOtp, '441920');

    // Create Outlook Alias
    const outlookCreate = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'POST',
      headers: uiHeaders,
      body: JSON.stringify({
        mode: 'alias',
        provider: 'outlook-alias',
        baseEmail: 'tester@outlook.com',
        tag: 'shop',
      }),
    });
    assert.equal(outlookCreate.status, 201);
    const { inbox: outlookInbox } = await outlookCreate.json();
    assert.equal(outlookInbox.address, 'tester+shop@outlook.com');

    // Admin routes reject unauthenticated or UI-only tokens
    const unauthAdmin = await fetch(`${srv.baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${uiToken}` },
    });
    assert.equal(unauthAdmin.status, 401);

    const statusBefore = await (await fetch(`${srv.baseUrl}/api/admin/status`)).json();
    assert.equal(statusBefore.configured, false);
    assert.equal(statusBefore.authenticated, false);

    // First-run setup claims admin passcode and issues admin Bearer token
    const setupRes = await fetch(`${srv.baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'admin-pass-2026' }),
    });
    assert.equal(setupRes.status, 201);
    const { token: adminToken } = await setupRes.json();
    assert.ok(adminToken.startsWith('fm_adm_'));

    // Duplicate setup blocked with 409 Conflict
    const dupSetup = await fetch(`${srv.baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'hijack-999' }),
    });
    assert.equal(dupSetup.status, 409);

    // Wrong login rejected with 401
    const badLogin = await fetch(`${srv.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'wrong-pass' }),
    });
    assert.equal(badLogin.status, 401);

    // Authenticated Admin overview & inbox moderation
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };
    const ovRes = await fetch(`${srv.baseUrl}/api/admin/overview`, { headers: adminHeaders });
    assert.equal(ovRes.status, 200);
    const ovBody = await ovRes.json();
    assert.equal(ovBody.overview.inboxesTotal, 2);
    assert.equal(ovBody.overview.byProvider['gmail-alias'], 1);
    assert.equal(ovBody.overview.byProvider['outlook-alias'], 1);

    const patchInbox = await fetch(`${srv.baseUrl}/api/admin/inboxes/${outlookInbox.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'paused' }),
    });
    assert.equal(patchInbox.status, 200);
    assert.equal((await patchInbox.json()).inbox.status, 'paused');

    // Logout revokes admin token immediately
    await fetch(`${srv.baseUrl}/api/admin/logout`, { method: 'POST', headers: adminHeaders });
    const afterLogout = await fetch(`${srv.baseUrl}/api/admin/overview`, { headers: adminHeaders });
    assert.equal(afterLogout.status, 401);
  } finally {
    await srv.close();
  }
});

test('integration: POST /api/v1/messages/bulk performs bulk read, star, trash, and permanent delete', async () => {
  const srv = await startTestServer();
  try {
    const token = await issueAuthenticatedSession(srv.baseUrl, srv.instance);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const createRes = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'webhook', prefix: 'bulk-http', domain: 'relaybox.dev' }),
    });
    const { inbox } = await createRes.json();

    const ids: string[] = [];
    for (const i of [1, 2, 3]) {
      const ingestRes = await fetch(`${srv.baseUrl}/api/v1/inbound`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: inbox.address,
          from: 'sender@example.com',
          subject: `Bulk Msg ${i}`,
          text: `Body ${i}`,
        }),
      });
      const { message } = await ingestRes.json();
      ids.push(message.id);
    }

    const markReadRes = await fetch(`${srv.baseUrl}/api/v1/messages/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messageIds: [ids[0], ids[1]], action: 'markRead' }),
    });
    assert.equal(markReadRes.status, 200);
    const markReadBody = await markReadRes.json();
    assert.equal(markReadBody.affected, 2);
    assert.equal(markReadBody.updated.every((m: { read: boolean }) => m.read), true);

    const starRes = await fetch(`${srv.baseUrl}/api/v1/messages/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messageIds: ids, action: 'star' }),
    });
    assert.equal(starRes.status, 200);
    const starBody = await starRes.json();
    assert.equal(starBody.affected, 3);
    assert.equal(starBody.updated.every((m: { starred: boolean }) => m.starred), true);

    const delRes = await fetch(`${srv.baseUrl}/api/v1/messages/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messageIds: [ids[0], ids[2]], action: 'delete', permanent: true }),
    });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json();
    assert.equal(delBody.affected, 2);
    assert.equal(delBody.deletedIds.length, 2);

    const remainingRes = await fetch(`${srv.baseUrl}/api/v1/inboxes/${inbox.id}/messages`, {
      headers,
    });
    const remainingBody = await remainingRes.json();
    assert.equal(remainingBody.messages.length, 1);
    assert.equal(remainingBody.messages[0].id, ids[1]);
  } finally {
    await srv.close();
  }
});

test('integration: POST /api/v1/inboxes with deliverCredentialsEmail sends password email into new inbox', async () => {
  const srv = await startTestServer();
  try {
    const token = await issueAuthenticatedSession(srv.baseUrl, srv.instance);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const createRes = await fetch(`${srv.baseUrl}/api/v1/inboxes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'alias',
        provider: 'outlook-alias',
        deliverCredentialsEmail: true,
      }),
    });
    assert.equal(createRes.status, 201);
    const { inbox } = await createRes.json();
    assert.equal(inbox.messageCount, 1);

    const msgsRes = await fetch(`${srv.baseUrl}/api/v1/inboxes/${inbox.id}/messages`, { headers });
    const msgsBody = await msgsRes.json();
    assert.equal(msgsBody.messages.length, 1);
    assert.ok(msgsBody.messages[0].subject.includes(inbox.address));
    assert.ok(msgsBody.messages[0].text.includes('รหัสผ่าน: Rb_'));
  } finally {
    await srv.close();
  }
});
