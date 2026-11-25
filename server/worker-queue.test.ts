import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailboxDatabase } from './db.ts';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybox-queue-'));
  const dbPath = path.join(dir, 'queue.db');
  const db = new MailboxDatabase({ dbPath });
  return { dir, dbPath, db };
}

test('job queue claims work once, completes it, and recovers stale leases', async () => {
  const { dir, db } = tempDb();
  try {
    assert.equal(
      await db.enqueueJob({
        id: 'job-1',
        type: 'webhook.retry',
        payload: { eventId: 'evt_1' },
        idempotencyKey: 'webhook-retry:evt_1',
        runAt: new Date(Date.now() - 1000).toISOString(),
      }),
      true,
    );
    assert.equal(
      await db.enqueueJob({
        id: 'job-duplicate',
        type: 'webhook.retry',
        payload: { eventId: 'evt_1' },
        idempotencyKey: 'webhook-retry:evt_1',
      }),
      false,
    );

    const claimed = await db.claimJobs('worker-a', 4);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, 'job-1');
    assert.equal(claimed[0].status, 'running');
    assert.equal((await db.claimJobs('worker-b', 4)).length, 0);

    await db.completeJob('job-1');
    assert.equal((await db.claimJobs('worker-b', 4)).length, 0);

    assert.equal(
      await db.enqueueJob({
        id: 'job-2',
        type: 'mailbox.sync',
        payload: {},
        runAt: new Date(Date.now() - 1000).toISOString(),
      }),
      true,
    );
    assert.equal((await db.claimJobs('worker-a', 4, 0)).length, 1);
    assert.equal(await db.recoverStaleJobs(0), 1);
    assert.equal((await db.claimJobs('worker-b', 4)).length, 1);
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('job queue applies exponential backoff then marks dead-letter jobs', async () => {
  const { dir, db } = tempDb();
  try {
    await db.enqueueJob({
      id: 'job-fail',
      type: 'webhook.retry',
      payload: {},
      maxAttempts: 3,
      runAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal((await db.claimJobs('worker-a', 4)).length, 1);
    assert.equal(await db.failJob('job-fail', 'HTTP 500', 60), 'retry');

    const retry = (await db.listJobs(1))[0];
    assert.equal(retry.status, 'pending');
    assert.equal(retry.attempts, 1);
    assert.ok(new Date(retry.runAt).getTime() > Date.now());

    assert.equal(await db.failJob('job-fail', 'HTTP 500', 60), 'retry');
    assert.equal(await db.failJob('job-fail', 'HTTP 500', 60), 'dead');
    assert.equal((await db.listJobs(1))[0].status, 'dead');
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker heartbeats are persisted and migrations include the queue schema', async () => {
  const { dir, db } = tempDb();
  try {
    assert.ok((await db.getMigrationCount()) >= 3);
    await db.recordWorkerHeartbeat('worker-test', 7);
    const [heartbeat] = await db.listWorkerHeartbeats();
    assert.equal(heartbeat.name, 'worker-test');
    assert.equal(heartbeat.jobsProcessed, 7);
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
