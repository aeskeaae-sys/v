import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const COUNTED_TABLES = [
  'schema_migrations',
  'inboxes',
  'messages',
  'api_keys',
  'webhooks',
  'webhook_deliveries',
  'webhook_seen_events',
  'activities',
  'api_usage_logs',
  'settings',
  'auth_sessions',
  'rate_limits',
  'job_queue',
  'worker_heartbeats',
];

export interface BackupReport {
  backupPath: string;
  bytes: number;
  integrity: 'ok' | string;
  counts: Record<string, number>;
  createdAt: string;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    counts[table] = Number(row.cnt);
  }
  return counts;
}

function inspectBackup(backupPath: string): { integrity: string; counts: Record<string, number> } {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }
  const db = new DatabaseSync(backupPath);
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return { integrity: integrityRow.integrity_check, counts: tableCounts(db) };
  } finally {
    db.close();
  }
}

export function createBackup(sourcePath: string, backupPath: string): BackupReport {
  const source = path.resolve(sourcePath);
  const target = path.resolve(backupPath);
  if (!fs.existsSync(source)) throw new Error(`Database not found: ${source}`);
  if (source === target) throw new Error('Backup path must differ from the live database path.');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec(`VACUUM INTO ${quoteLiteral(target)};`);
  } finally {
    db.close();
  }

  const inspected = inspectBackup(target);
  if (inspected.integrity !== 'ok') {
    throw new Error(`Backup integrity check failed: ${inspected.integrity}`);
  }
  return {
    backupPath: target,
    bytes: fs.statSync(target).size,
    integrity: inspected.integrity,
    counts: inspected.counts,
    createdAt: new Date().toISOString(),
  };
}

export function restoreBackup(backupPath: string, targetPath: string): BackupReport {
  const backup = path.resolve(backupPath);
  const target = path.resolve(targetPath);
  if (!fs.existsSync(backup)) throw new Error(`Backup file not found: ${backup}`);
  if (backup === target) throw new Error('Restore target must differ from the backup file.');

  const inspected = inspectBackup(backup);
  if (inspected.integrity !== 'ok') {
    throw new Error(`Backup integrity check failed: ${inspected.integrity}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = `${target}.restore-${process.pid}-${Date.now()}`;
  fs.copyFileSync(backup, staging);
  try {
    const staged = inspectBackup(staging);
    if (staged.integrity !== 'ok') throw new Error('Staged restore failed integrity check.');
    if (JSON.stringify(staged.counts) !== JSON.stringify(inspected.counts)) {
      throw new Error('Staged restore row counts do not match the backup.');
    }
    fs.renameSync(staging, target);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${target}${suffix}`;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
    }
  } catch (err) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { force: true });
    throw err;
  }

  return {
    backupPath: backup,
    bytes: fs.statSync(target).size,
    integrity: inspected.integrity,
    counts: inspected.counts,
    createdAt: new Date().toISOString(),
  };
}

export function checkMigrations(targetPath: string): {
  version: number;
  count: number;
  integrity: string;
  counts: Record<string, number>;
} {
  const target = path.resolve(targetPath);
  if (!fs.existsSync(target)) throw new Error(`Database not found: ${target}`);
  const db = new DatabaseSync(target);
  try {
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    const version = Number(
      (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version,
    );
    const count = Number(
      (db.prepare('SELECT COUNT(*) AS cnt FROM schema_migrations').get() as { cnt: number }).cnt,
    );
    return { version, count, integrity, counts: tableCounts(db) };
  } finally {
    db.close();
  }
}
