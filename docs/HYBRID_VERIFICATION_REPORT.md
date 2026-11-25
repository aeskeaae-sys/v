# Hybrid Verification Report

รายงานผลจากการรันจริงใน workspace `C:\Users\tee\Downloads\flowmail-api` หลังการปรับปรุง

## ผลลัพธ์ที่รันแล้ว

| คำสั่ง | ผลลัพธ์ |
|---|---|
| `& "C:\Program Files\nodejs\npm.cmd" run lint` | PASS (`tsc --noEmit`) |
| `& "C:\Program Files\nodejs\npm.cmd" test` | PASS 43 tests, 0 fail (Phase 11 เพิ่ม test ของ expired session) |
| `& "C:\Program Files\nodejs\npm.cmd" run build` | PASS; เหลือ warning chunk > 500 kB (ไม่ใช่ error) |
| `& "C:\Program Files\nodejs\npm.cmd" run check:env` (dev) | PASS `[ok] environment validation passed` |
| `NODE_ENV=production` + ไม่มี secret → `npm run check:env` | exit 1 พร้อม error 4 ตัวตามที่ออกแบบ |
| `& "C:\Program Files\nodejs\npm.cmd" run migrate:check` | `version: 3`, `count: 3`, `integrity: ok` |
| `& "C:\Program Files\nodejs\npm.cmd" run backup -- <temp>\backup.db` | `integrity: ok`, bytes `200704`, row counts ตรงตาม DB |
| worker smoke: `node node_modules\tsx\dist\cli.mjs worker.ts` | `[worker] ... started; migrations=3`, heartbeat ถูกบันทึกใน DB |
| `npm install --package-lock-only` + `npm ci --dry-run` | PASS; lock file ตรงกับ `package.json` |

หมายเหตุ: `npm.ps1` ถูก PowerShell policy บล็อก จึงใช้ path เต็ม `C:\Program Files\nodejs\npm.cmd` ตลอด

Phase 11 addendum: รายงานการตรวจสอบแหล่งกำเนิด/ความปลอดภัย/การดีพลอยภายนอกฉบับสมบูรณ์อยู่ที่ `docs/PHASE11_EXTERNAL_DEPLOYMENT_VERIFICATION.md`

## สิ่งที่ทดสอบด้วยชุดทดสอบใหม่

- anonymous session ได้ `read` เท่านั้น และถูกปฏิเสธ write/admin routes (`403 INSUFFICIENT_SCOPE`)
- `{passcode}` / `{apiKey}` ผิดถูกปฏิเสธ `401`
- logout เพิกถอน session จน token เก่าใช้ไม่ได้ (`401`)
- CORS allowlist + state-changing origin guard (`403 ORIGIN_NOT_ALLOWED`)
- session และ rate-limit ใช้ร่วมกันได้ระหว่าง 2 app instance บน database เดียวกัน
- production env validation ปฏิเสธ secret ค่าเริ่มต้น
- DNS rebinding / metadata address ถูกปฏิเสธก่อนส่ง webhook; redirect ถูกปิด (`redirect: 'manual'`)
- backup/restore ตรวจ `integrity_check` และ row counts ก่อนแทนที่ไฟล์จริง
- job queue: claim once, lease recovery, backoff, dead-letter, heartbeat

## ไฟล์สำคัญที่เปลี่ยน

- `server/auth.ts`, `server/env.ts`, `server/backup.ts` — สร้างใหม่
- `server/db.ts` — migrations v2/v3, session/rate-limit/job queue methods, `FLOWMAIL_DB_PATH`, `close()`
- `server.ts` — auth/CORS/origin/security headers, graceful shutdown, webhook retry enqueue, worker health endpoint, `dotenv/config`
- `server/integration.test.ts`, `server/security.test.ts`, `server/parser.test.ts`, `server/worker-queue.test.ts`, `server/backup.test.ts` — ทดสอบ
- `worker.ts`, `scripts/*.ts` — worker และ script ปฏิบัติการ
- `src/api/client.ts` — `VITE_API_BASE_URL`, `configureSessionCredentials`, revoke ทั้ง admin/session ตอน logout
- `src/components/ActivityLogView.tsx`, `shared/types.ts` — activity event ใหม่
- `package.json`, `package-lock.json` — scripts ใหม่, `esbuild ^0.28.2`, `tsx` เป็น runtime dependency
- `.env.example`, `vite.config.ts`, `Dockerfile`, `docker-compose.yml`, `vercel.json`, `docs/HYBRID_DEPLOYMENT.md`

## ข้อจำกัดที่ยังต้องตรวจภายนอก

- ไม่มี `.git`: `fatal: not a git repository (or any of the parent directories): .git` ยังทำให้ตรวจ branch/HEAD/diff ไม่ได้
- `docker` ไม่มีในเครื่อง: `docker : The term 'docker' is not recognized ...` จึงยังไม่ได้ build image หรือรัน compose จริง
- ยังไม่ได้ deploy จริงบน Vercel/Render/Fly; `vercel.json` เป็น SPA-only ตามที่ออกแบบ
- ยังไม่ได้ทดสอบ Mail.tm/SMTP จริงกับ network ภายนอก; ใช้การทดสอบในหน่วย/Integration แทน
- SQLite ยังเป็น single-writer; ยังไม่มี PostgreSQL adapter
- build warning: bundle `1,040.99 kB` (gzip `295.70 kB`) เกิน 500 kB; ยังไม่ได้ code-split
