import 'dotenv/config';
import { validateProductionEnv } from '../server/env.ts';

const report = validateProductionEnv();
for (const warning of report.warnings) console.warn(`[warn] ${warning}`);

if (!report.ok) {
  for (const error of report.errors) console.error(`[error] ${error}`);
  process.exit(1);
}

console.log('[ok] environment validation passed');
