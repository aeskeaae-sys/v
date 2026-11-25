import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabaseClient, type DatabaseClient } from './database-client.ts';

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

const INSERT_ORDER = COUNTED_TABLES;
const DELETE_ORDER = [...COUNTED_TABLES].reverse();
const JSON_BACKUP_FORMAT = 'relaybox-postgres-json-v1';

export interface BackupReport {
  backupPath: string;
  bytes: number;
  integrity: 'ok' | string;
  counts: Record<string, number>;
  createdAt: string;
}

interface JsonBackup {
  format: typeof JSON_BACKUP_FORMAT;
  createdAt: string;
  integrity: string;
  version: number;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

function isPostgres(): boolean {
  return Boolean((process.env.DATABASE_URL || '').trim());
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid identifier in backup: ${value}`);
  }
  return `"${value}"`;
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    counts[table] = Number(row.cnt);
  }
  return counts;
}

async function postgresTableCounts(client: DatabaseClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const row = await client.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
    counts[table] = Number(row?.cnt ?? 0);
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

function readJsonBackup(backupPath: string): JsonBackup {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as Partial<JsonBackup>;
  if (parsed.format !== JSON_BACKUP_FORMAT) {
    throw new Error('Unsupported PostgreSQL backup format.');
  }
  if (!parsed.tables || typeof parsed.tables !== 'object') {
    throw new Error('PostgreSQL backup is missing table data.');
  }
  for (const table of COUNTED_TABLES) {
    if (!Array.isArray(parsed.tables[table])) {
      throw new Error(`PostgreSQL backup is missing rows for ${table}.`);
    }
  }
  return {
    format: JSON_BACKUP_FORMAT,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    integrity: typeof parsed.integrity === 'string' ? parsed.integrity : 'ok',
    version: Number(parsed.version ?? 0),
    counts: (parsed.counts ?? {}) as Record<string, number>,
    tables: parsed.tables as Record<string, Record<string, unknown>[]>,
  };
}

async function createPostgresBackup(backupPath: string): Promise<BackupReport> {
  const client = createDatabaseClient();
  await client.connect();
  try {
    const versionRow = await client
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get();
    const counts = await postgresTableCounts(client);
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of COUNTED_TABLES) {
      tables[table] = await client.prepare(`SELECT * FROM ${table}`).all();
    }
    const backup: JsonBackup = {
      format: JSON_BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      integrity: 'ok',
      version: Number(versionRow?.version ?? 0),
      counts,
      tables,
    };
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
    return {
      backupPath,
      bytes: fs.statSync(backupPath).size,
      integrity: 'ok',
      counts,
      createdAt: backup.createdAt,
    };
  } finally {
    await client.close();
  }
}

function createSqliteBackup(sourcePath: string, backupPath: string): BackupReport {
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

async function restorePostgresBackup(backupPath: string): Promise<BackupReport> {
  const backup = readJsonBackup(backupPath);
  if (backup.integrity !== 'ok') {
    throw new Error(`Backup integrity check failed: ${backup.integrity}`);
  }

  const client = createDatabaseClient();
  await client.connect();
  try {
    await client.exec('BEGIN');
    try {
      for (const table of DELETE_ORDER) {
        await client.exec(`DELETE FROM ${table}`);
      }
      for (const table of INSERT_ORDER) {
        const rows = backup.tables[table];
        for (const row of rows) {
          const columns = Object.keys(row);
          if (columns.length === 0) continue;
          const columnSql = columns.map((column) => quoteIdentifier(column)).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          const values = columns.map((column) => row[column] ?? null);
          await client
            .prepare(`INSERT INTO ${table} (${columnSql}) VALUES (${placeholders})`)
            .run(...values);
        }
      }
      await client.exec('COMMIT');
    } catch (err) {
      await client.exec('ROLLBACK');
      throw err;
    }

    const counts = await postgresTableCounts(client);
    for (const table of COUNTED_TABLES) {
      if (Number(counts[table]) !== Number(backup.counts[table] ?? 0)) {
        throw new Error(`Restored row counts do not match the backup for ${table}.`);
      }
    }
    return {
      backupPath,
      bytes: fs.statSync(backupPath).size,
      integrity: 'ok',
      counts,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await client.close();
  }
}

function restoreSqliteBackup(backupPath: string, targetPath: string): BackupReport {
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

export async function createBackup(sourcePath: string, backupPath: string): Promise<BackupReport> {
  if (isPostgres()) return await createPostgresBackup(path.resolve(backupPath));
  return createSqliteBackup(sourcePath, backupPath);
}

export async function restoreBackup(backupPath: string, targetPath: string): Promise<BackupReport> {
  if (isPostgres()) return await restorePostgresBackup(path.resolve(backupPath));
  return restoreSqliteBackup(backupPath, targetPath);
}

export async function checkMigrations(targetPath: string): Promise<{
  version: number;
  count: number;
  integrity: string;
  counts: Record<string, number>;
}> {
  if (isPostgres()) {
    const client = createDatabaseClient();
    await client.connect();
    try {
      await client.prepare('SELECT 1 AS ok').get();
      const versionRow = await client
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get();
      const countRow = await client
        .prepare('SELECT COUNT(*) AS cnt FROM schema_migrations')
        .get();
      return {
        version: Number(versionRow?.version ?? 0),
        count: Number(countRow?.cnt ?? 0),
        integrity: 'ok',
        counts: await postgresTableCounts(client),
      };
    } finally {
      await client.close();
    }
  }

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
