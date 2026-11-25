import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowMailStore } from './store.ts';

test('creates webhook inboxes, prevents duplicates, and keeps private credentials out of public views', async () => {
  const store = new FlowMailStore({ filePath: null });
  const custom = await store.createInbox({ prefix: 'signup-ops', domain: 'flowmail.cc', ttl: '1h' });
  assert.equal(custom.address, 'signup-ops@flowmail.cc');
  assert.equal(custom.mode, 'webhook');
  assert.ok(custom.expiresAt !== null);

  await assert.rejects(async () => {
    await store.createInbox({ prefix: 'signup-ops', domain: 'flowmail.cc' });
  }, /already exists/);

  const live = await store.registerLiveMxInbox({
    address: 'live-123@euploading.com',
    localPart: 'live-123',
    domain: 'euploading.com',
    remoteAccountId: 'acc_1',
    remotePassword: 'secret_password',
    remoteToken: 'secret_jwt',
  });

  assert.equal(live.mode, 'live-mx');
  assert.equal('credentials' in live, false);
});

test('ingests messages, deduplicates by remoteId, updates read/starred state, and extracts OTPs', async () => {
  const store = new FlowMailStore({ filePath: null });
  const inbox = await store.createInbox({ prefix: 'otp-check', domain: 'mail.flowmail.cc' });

  const msg = await store.ingestMessage({
    to: inbox.address,
    from: 'noreply@service.com',
    subject: 'Confirm login',
    text: 'Your security code is 609341.',
    remoteId: 'rm_001',
  });

  const duplicate = await store.ingestMessage({
    to: inbox.address,
    from: 'noreply@service.com',
    subject: 'Confirm login',
    text: 'Your security code is 609341.',
    remoteId: 'rm_001',
  });

  assert.equal(msg.id, duplicate.id);
  assert.equal(msg.extracted.primaryOtp, '609341');
  assert.equal((await store.getInboxByIdOrAddress(inbox.id))?.messageCount, 1);
  assert.equal((await store.getInboxByIdOrAddress(inbox.id))?.unreadCount, 1);

  await store.updateMessage(msg.id, { read: true, starred: true });
  assert.equal((await store.getInboxByIdOrAddress(inbox.id))?.unreadCount, 0);
  assert.equal((await store.getMessage(msg.id))?.starred, true);
  assert.equal((await store.listMessages(inbox.id, { starredOnly: true })).length, 1);
});

test('autoCreateInbox provisions webhook inbox on first incoming message when enabled', async () => {
  const store = new FlowMailStore({ filePath: null });
  const msg = await store.ingestMessage({
    to: 'orders-77@flowmail.cc',
    subject: 'Order received',
    text: 'Thank you',
    autoCreateInbox: true,
  });

  const inbox = await store.getInboxByIdOrAddress('orders-77@flowmail.cc');
  assert.ok(inbox);
  assert.equal(msg.inboxId, inbox.id);
});

test('waitForMessage resolves when matching message arrives', async () => {
  const store = new FlowMailStore({ filePath: null });
  const inbox = await store.createInbox({ prefix: 'wait-test', domain: 'flowmail.cc' });

  const waitPromise = store.waitForMessage(inbox.address, {
    timeoutMs: 2000,
    subject: 'Verify',
  });

  setTimeout(() => {
    void (async () => {
      await store.ingestMessage({
        to: inbox.address,
        subject: 'Newsletter',
        text: 'No code here',
      });
      await store.ingestMessage({
        to: inbox.address,
        subject: 'Verify your account',
        text: 'Code: 998811',
      });
    })().catch(() => undefined);
  }, 20);

  const matched = await waitPromise;
  assert.ok(matched);
  assert.equal(matched.extracted.primaryOtp, '998811');
});

test('API keys are hashed on store and verified via timingSafeEqual', async () => {
  const store = new FlowMailStore({ filePath: null });
  const { summary, plaintextKey } = await store.createApiKey('Automation Key');
  assert.ok(plaintextKey.startsWith('fm_live_'));
  assert.equal((await store.listApiKeys()).length, 1);
  assert.equal((await store.verifyApiKey(plaintextKey))?.id, summary.id);
  assert.equal(await store.verifyApiKey('fm_live_wrongkey'), null);
  assert.equal(await store.revokeApiKey(summary.id), true);
  assert.equal(await store.verifyApiKey(plaintextKey), null);
});

test('supports folders (inbox, sent, drafts, spam, trash), internal delivery, and restore/permanent delete', async () => {
  const store = new FlowMailStore({ filePath: null });
  const sender = await store.createInbox({ prefix: 'alice', domain: 'relaybox.dev' });
  const receiver = await store.createInbox({ prefix: 'bob', domain: 'relaybox.dev' });

  // Internal send creates sent copy for sender AND delivers into receiver's inbox!
  const sentMsg = await store.saveDraftOrSentMessage({
    inboxIdOrAddress: sender.id,
    to: receiver.address,
    subject: 'Internal Ping',
    text: 'Verification code: 135790',
    mode: 'sent',
  });
  assert.equal(sentMsg.folder, 'sent');
  assert.equal((await store.listMessages(receiver.id, { folder: 'inbox' })).length, 1);
  assert.equal((await store.listMessages(receiver.id, { folder: 'inbox' }))[0].extracted.primaryOtp, '135790');

  // Soft-delete moves to trash, restore returns to inbox, permanent delete removes row
  const receiverMsg = (await store.listMessages(receiver.id, { folder: 'inbox' }))[0];
  assert.equal(await store.deleteMessage(receiverMsg.id, false), true);
  assert.equal((await store.getMessage(receiverMsg.id))?.folder, 'trash');
  await store.updateMessage(receiverMsg.id, { folder: 'inbox' });
  assert.equal((await store.getMessage(receiverMsg.id))?.folder, 'inbox');
  assert.equal(await store.deleteMessage(receiverMsg.id, true), true);
  assert.equal(await store.getMessage(receiverMsg.id), null);

  // Executable attachment is blocked at ingestion
  await assert.rejects(async () => {
    await store.ingestMessage({
      to: receiver.address,
      subject: 'Executable test',
      text: 'See attached',
      attachments: [{ filename: 'prize.exe', contentType: 'application/octet-stream', size: 100 }],
    });
  }, /Executable attachment/);

  // Spam routing without executable attachment
  const spamMsg = await store.ingestMessage({
    to: receiver.address,
    from: 'winner@scam.invalid',
    subject: 'URGENT: Claim $1,000,000 crypto lottery prize! Verify your bank account now!',
    text: 'Winner! Wire bitcoins urgently to claim your inheritance prize.',
    html: '<script>evil()</script>',
    headers: { 'authentication-results': 'spf=fail' },
  });
  assert.equal(spamMsg.folder, 'spam');
  assert.ok(spamMsg.spamScore >= 60);
});

test('surfaces Mail.tm 429 rate limits and applies store sync cooldown without marking inbox broken', async (t) => {
  const { MailTmRateLimitError, fetchNewLiveMxMessages } = await import('./mailtm.ts');
  const store = new FlowMailStore({ filePath: null });
  const live = await store.registerLiveMxInbox({
    address: 'rate-test@euploading.com',
    localPart: 'rate-test',
    domain: 'euploading.com',
    remoteAccountId: 'acc_rl',
    remotePassword: 'secret_password',
    remoteToken: 'secret_jwt',
  });

  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ detail: 'Too Many Requests' }), {
      status: 429,
      headers: { 'Retry-After': '12' },
    });
  });

  await assert.rejects(
    () =>
      fetchNewLiveMxMessages(
        live.address,
        {
          remoteAccountId: 'acc_rl',
          remotePassword: 'secret_password',
          remoteToken: 'secret_jwt',
        },
        new Set(),
      ),
    (err: unknown) => err instanceof MailTmRateLimitError && err.retryAfterSec === 12,
  );

  // Forced sync hits 429, sets cooldown + syncError, and keeps status active
  await assert.rejects(
    () => store.syncLiveInbox(live.id, { force: true }),
    (err: unknown) => err instanceof MailTmRateLimitError,
  );
  const afterRateLimit = await store.getInboxByIdOrAddress(live.id);
  assert.equal(afterRateLimit?.status, 'active');
  assert.ok(afterRateLimit?.syncError?.includes('429'));

  // Subsequent background sync during cooldown skips hitting remote fetch
  const callsBeforeCooldownSync = fetchCalls;
  const skipped = await store.syncLiveInbox(live.id);
  assert.equal(skipped.added.length, 0);
  assert.equal(fetchCalls, callsBeforeCooldownSync);
});

test('creates Gmail and Outlook aliases, prevents invalid domain mismatches, and marks synced', async () => {
  const store = new FlowMailStore({ filePath: null });

  const gmailPlus = await store.createAliasInbox({
    baseEmail: 'somwang@gmail.com',
    provider: 'gmail-alias',
    strategy: 'plus',
    tag: 'shopee01',
  });
  assert.equal(gmailPlus.address, 'somwang+shopee01@gmail.com');
  assert.equal(gmailPlus.mode, 'alias');
  assert.equal(gmailPlus.provider, 'gmail-alias');

  const gmailDot = await store.createAliasInbox({
    baseEmail: 'somwang@gmail.com',
    provider: 'gmail-alias',
    strategy: 'dot',
  });
  assert.equal(gmailDot.address, 's.omwang@gmail.com');
  assert.equal(gmailDot.provider, 'gmail-alias');

  const outlookPlus = await store.createAliasInbox({
    baseEmail: 'myuser@outlook.com',
    provider: 'outlook-alias',
    strategy: 'plus',
    tag: 'netflix',
  });
  assert.equal(outlookPlus.address, 'myuser+netflix@outlook.com');
  assert.equal(outlookPlus.mode, 'alias');
  assert.equal(outlookPlus.provider, 'outlook-alias');

  await assert.rejects(async () => {
    await store.createAliasInbox({
      baseEmail: 'somwang@gmail.com',
      provider: 'outlook-alias',
    });
  }, /Outlook Alias/);

  await assert.rejects(async () => {
    await store.createAliasInbox({
      baseEmail: 'myuser@hotmail.com',
      provider: 'gmail-alias',
    });
  }, /Outlook\/Hotmail/);

  const synced = await store.markInboxSynced(gmailPlus.id, 2);
  assert.ok(synced?.lastSyncedAt);

  // Optional baseEmail generates clean random Gmail/Outlook addresses
  const autoGmail = await store.createAliasInbox({
    provider: 'gmail-alias',
    tag: 'promo',
  });
  assert.match(autoGmail.address, /^rb[0-9a-f]+\+promo@gmail\.com$/);
  assert.equal(autoGmail.provider, 'gmail-alias');

  const autoGmailDot = await store.createAliasInbox({
    provider: 'gmail-alias',
    strategy: 'dot',
  });
  assert.match(autoGmailDot.address, /^r\.?[0-9a-z.]+@gmail\.com$/);

  const autoOutlook = await store.createAliasInbox({
    provider: 'outlook-alias',
  });
  assert.match(autoOutlook.address, /^rb[0-9a-f]+@outlook\.com$/);
  assert.equal(autoOutlook.provider, 'outlook-alias');
});

test('handles atomic first-run admin passcode setup, scrypt verification, update, and overview stats', async () => {
  const store = new FlowMailStore({ filePath: null });
  assert.equal(await store.isAdminPasscodeConfigured(), false);

  assert.equal(await store.claimInitialAdminPasscode('secret-admin-99'), true);
  assert.equal(await store.isAdminPasscodeConfigured(), true);
  // Second claim must fail atomically
  assert.equal(await store.claimInitialAdminPasscode('attacker-pass'), false);

  assert.equal(await store.verifyAdminPasscode('secret-admin-99'), true);
  assert.equal(await store.verifyAdminPasscode('wrong-pass'), false);

  await store.updateAdminPasscode('secret-admin-99', 'new-admin-2026');
  assert.equal(await store.verifyAdminPasscode('new-admin-2026'), true);
  assert.equal(await store.verifyAdminPasscode('secret-admin-99'), false);

  await store.createAliasInbox({
    baseEmail: 'demo@gmail.com',
    provider: 'gmail-alias',
    tag: 'test1',
  });
  const overview = await store.getAdminOverview({
    requireApiKey: false,
    smtpPort: 2525,
    uptimeSeconds: 42,
  });
  assert.equal(overview.inboxesTotal, 1);
  assert.equal(overview.byProvider['gmail-alias'], 1);
});

test('bulkActionMessages marks read/unread, stars/unstars, moves to trash, restores, and permanently deletes', async () => {
  const store = new FlowMailStore({ filePath: null });
  const inbox = await store.createInbox({ prefix: 'bulk-ops', domain: 'relaybox.dev' });

  const m1 = await store.ingestMessage({ to: inbox.address, subject: 'One', text: '1' });
  const m2 = await store.ingestMessage({ to: inbox.address, subject: 'Two', text: '2' });
  const m3 = await store.ingestMessage({ to: inbox.address, subject: 'Three', text: '3' });

  const readRes = await store.bulkActionMessages([m1.id, m2.id], 'markRead');
  assert.equal(readRes.affected, 2);
  assert.equal((await store.getInboxByIdOrAddress(inbox.id))?.unreadCount, 1);

  const starRes = await store.bulkActionMessages([m1.id, m3.id], 'star');
  assert.equal(starRes.affected, 2);
  assert.equal((await store.getMessage(m1.id))?.starred, true);
  assert.equal((await store.getMessage(m3.id))?.starred, true);

  const unstarRes = await store.bulkActionMessages([m1.id], 'unstar');
  assert.equal(unstarRes.affected, 1);
  assert.equal((await store.getMessage(m1.id))?.starred, false);

  const unreadRes = await store.bulkActionMessages([m1.id], 'markUnread');
  assert.equal(unreadRes.affected, 1);
  assert.equal((await store.getInboxByIdOrAddress(inbox.id))?.unreadCount, 2);

  // Soft delete moves to trash
  const trashRes = await store.bulkActionMessages([m1.id, m2.id], 'delete');
  assert.equal(trashRes.affected, 2);
  assert.equal(trashRes.deletedIds.length, 0);
  assert.equal((await store.getMessage(m1.id))?.folder, 'trash');
  assert.equal((await store.getMessage(m2.id))?.folder, 'trash');

  // Restore moves back to inbox
  const restoreRes = await store.bulkActionMessages([m1.id], 'restore');
  assert.equal(restoreRes.affected, 1);
  assert.equal((await store.getMessage(m1.id))?.folder, 'inbox');

  // Deleting items already in trash permanently removes them
  const permRes = await store.bulkActionMessages([m2.id], 'delete');
  assert.equal(permRes.affected, 1);
  assert.deepEqual(permRes.deletedIds, [m2.id]);
  assert.equal(await store.getMessage(m2.id), null);
});

test('deliverCredentialsEmail delivers per-inbox password email for Webhook, Alias, and Live MX inboxes', async () => {
  const store = new FlowMailStore({ filePath: null });

  const webhookInbox = await store.createInbox({
    prefix: 'cred-hook',
    domain: 'relaybox.dev',
    deliverCredentialsEmail: true,
  });
  assert.equal(webhookInbox.messageCount, 1);
  const hookMsgs = await store.listMessages(webhookInbox.id, { folder: 'inbox' });
  assert.equal(hookMsgs.length, 1);
  assert.ok(hookMsgs[0].text.includes('รหัสผ่าน: Rb_'));
  assert.equal(hookMsgs[0].extracted.otpCodes.length, 0);

  const aliasInbox = await store.createAliasInbox({
    provider: 'gmail-alias',
    deliverCredentialsEmail: true,
  });
  assert.equal(aliasInbox.messageCount, 1);
  const aliasMsgs = await store.listMessages(aliasInbox.id, { folder: 'inbox' });
  assert.ok(aliasMsgs[0].text.includes('รหัสผ่าน: Rb_'));

  const liveInbox = await store.registerLiveMxInbox(
    {
      address: 'live-cred@euploading.com',
      localPart: 'live-cred',
      domain: 'euploading.com',
      remoteAccountId: 'acc_cred',
      remotePassword: 'Fm_liveSecretPass99',
      remoteToken: 'tok_cred',
    },
    { deliverCredentialsEmail: true },
  );
  assert.equal(liveInbox.messageCount, 1);
  const liveMsgs = await store.listMessages(liveInbox.id, { folder: 'inbox' });
  assert.ok(liveMsgs[0].text.includes('Fm_liveSecretPass99'));
});
