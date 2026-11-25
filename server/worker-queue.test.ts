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

test('job queue claims work once, completes it, and recovers stale leases', () => {
  const { dir, db } = tempDb();
  try {
    assert.equal(
      db.enqueueJob({
        id: 'job-1',
        type: 'webhook.retry',
        payload: { eventId: 'evt_1' },
        idempotencyKey: 'webhook-retry:evt_1',
        runAt: new Date(Date.now() - 1000).toISOString(),
      }),
      true,
    );
    assert.equal(
      db.enqueueJob({
        id: 'job-duplicate',
        type: 'webhook.retry',
        payload: { eventId: 'evt_1' },
        idempotencyKey: 'webhook-retry:evt_1',
      }),
      false,
    );

    const claimed = db.claimJobs('worker-a', 4);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, 'job-1');
    assert.equal(claimed[0].status, 'running');
    assert.equal(db.claimJobs('worker-b', 4).length, 0);

    db.completeJob('job-1');
    assert.equal(db.claimJobs('worker-b', 4).length, 0);

    assert.equal(
      db.enqueueJob({
        id: 'job-2',
        type: 'mailbox.sync',
        payload: {},
        runAt: new Date(Date.now() - 1000).toISOString(),
      }),
      true,
    );
    assert.equal(db.claimJobs('worker-a', 4, 0).length, 1);
    assert.equal(db.recoverStaleJobs(0), 1);
    assert.equal(db.claimJobs('worker-b', 4).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('job queue applies exponential backoff then marks dead-letter jobs', () => {
  const { dir, db } = tempDb();
  try {
    db.enqueueJob({
      id: 'job-fail',
      type: 'webhook.retry',
      payload: {},
      maxAttempts: 3,
      runAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(db.claimJobs('worker-a', 4).length, 1);
    assert.equal(db.failJob('job-fail', 'HTTP 500', 60), 'retry');

    const retry = db.listJobs(1)[0];
    assert.equal(retry.status, 'pending');
    assert.equal(retry.attempts, 1);
    assert.ok(new Date(retry.runAt).getTime() > Date.now());

    assert.equal(db.failJob('job-fail', 'HTTP 500', 60), 'retry');
    assert.equal(db.failJob('job-fail', 'HTTP 500', 60), 'dead');
    assert.equal(db.listJobs(1)[0].status, 'dead');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker heartbeats are persisted and migrations include the queue schema', () => {
  const { dir, db } = tempDb();
  try {
    assert.ok(db.getMigrationCount() >= 3);
    db.recordWorkerHeartbeat('worker-test', 7);
    const [heartbeat] = db.listWorkerHeartbeats();
    assert.equal(heartbeat.name, 'worker-test');
    assert.equal(heartbeat.jobsProcessed, 7);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
