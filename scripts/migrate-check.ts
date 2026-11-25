import 'dotenv/config';
import path from 'node:path';
import { checkMigrations } from '../server/backup.ts';

const dbPath = path.resolve(process.env.FLOWMAIL_DB_PATH || path.join('.data', 'mailbox.db'));

try {
  const report = await checkMigrations(dbPath);
  console.log(JSON.stringify(report, null, 2));
  if (report.integrity !== 'ok') throw new Error(`integrity_check=${report.integrity}`);
  if (report.version < 3 || report.count < 3) {
    throw new Error(`migration version ${report.version} is below required version 3`);
  }
} catch (err) {
  console.error(`[migrate:check] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
