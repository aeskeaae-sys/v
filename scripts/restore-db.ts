import 'dotenv/config';
import path from 'node:path';
import { restoreBackup } from '../server/backup.ts';

const backupPath = process.argv[2];
const confirmed = process.argv.includes('--confirm');

if (!backupPath) {
  console.error('[restore] usage: npm run restore -- <backup.db> --confirm');
  process.exit(1);
}

if (!confirmed) {
  console.error('[restore] refusing to overwrite the live database without --confirm.');
  console.error('[restore] stop API and worker processes first; keep the same encryption key.');
  process.exit(1);
}

const targetPath = path.resolve(
  process.env.FLOWMAIL_DB_PATH || path.join('.data', 'mailbox.db'),
);

try {
  const report = restoreBackup(backupPath, targetPath);
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.error(`[restore] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
