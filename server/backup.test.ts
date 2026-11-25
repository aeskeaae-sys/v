import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMigrations, createBackup, restoreBackup } from './backup.ts';
import { MailboxDatabase } from './db.ts';

test('SQLite backup, migration check, and restore preserve row counts and integrity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybox-backup-'));
  const dbPath = path.join(dir, 'live.db');
  const backupPath = path.join(dir, 'backups', 'live.db');
  const targetPath = path.join(dir, 'restored.db');

  const db = new MailboxDatabase({ dbPath });
  try {
    db.enqueueJob({
      id: 'backup-job',
      type: 'webhook.retry',
      payload: { eventId: 'evt_backup' },
    });
  } finally {
    db.close();
  }

  const backup = createBackup(dbPath, backupPath);
  assert.equal(backup.integrity, 'ok');
  assert.equal(backup.counts.job_queue, 1);

  const migration = checkMigrations(backupPath);
  assert.equal(migration.integrity, 'ok');
  assert.ok(migration.version >= 3);
  assert.ok(migration.count >= 3);

  const restored = restoreBackup(backupPath, targetPath);
  assert.equal(restored.integrity, 'ok');
  assert.equal(checkMigrations(targetPath).counts.job_queue, 1);

  assert.throws(() => createBackup(dbPath, dbPath), /must differ/);
  assert.throws(() => restoreBackup(backupPath, backupPath), /must differ/);
  fs.rmSync(dir, { recursive: true, force: true });
});
