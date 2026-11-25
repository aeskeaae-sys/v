import 'dotenv/config';
import path from 'node:path';
import { createBackup } from '../server/backup.ts';

const dbPath = path.resolve(
  process.env.FLOWMAIL_DB_PATH || path.join('.data', 'mailbox.db'),
);
const backupPath = path.resolve(
  process.argv[2] || path.join('.data', 'backups', `mailbox-${Date.now()}.db`),
);

try {
  const report = createBackup(dbPath, backupPath);
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.error(`[backup] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
