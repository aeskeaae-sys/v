# Hybrid Deployment Guide — FlowMail / RelayBox

## สถาปัตยกรรมที่รองรับ

```text
Browser (Vercel SPA)
   |  VITE_API_BASE_URL=https://api.example.com
   v
Persistent API service (Docker / VPS / Render / Fly)
   |-- Express API :3000
   |-- SSE, SMTP bridge (loopback), webhook receiver
   |-- SQLite file on persistent volume /data/mailbox.db
   v
Dedicated worker process
   |-- durable job_queue (webhook retries, backoff, dead-letter)
   |-- live MX sync, retention, session/rate-limit pruning
```

ทางเลือกอื่น: รัน API + worker ใน `docker compose` เดียวบน VPS (แนะนำสำหรับ SQLite) หรือแยก Vercel SPA กับ persistent backend ตามภาพด้านบน

## ข้อจำกัดของ SQLite

- ใช้ `node:sqlite` ที่มีอยู่แล้วใน Node 22.23.5; ไม่เพิ่ม driver ภายนอก
- SQLite รองรับ writer เดียว: รัน **API 1 instance + worker 1 instance** ต่อ database เดียว
- ต้องใช้ persistent volume; ห้ามใช้ ephemeral filesystem
- ตั้ง `PRAGMA busy_timeout = 5000` แล้ว; still ต้องหลีกเลี่ยง multiple writers
- หากต้องการ scale horizontal ต้องย้ายไป PostgreSQL และเพิ่ม adapter แทน `MailboxDatabase`

## Environment

-copy `.env.example` เป็น `.env` และตั้งค่าจริงใน secret manager (ห้าม commit secret)

Production validate (`npm run check:env`) บังคับ:

- `RELAYBOX_ENCRYPTION_KEY` >= 32 ตัวอักษร
- `ADMIN_PASSCODE` >= 12 ตัวอักษร
- `WEBHOOK_INBOUND_SECRET` >= 16 ตัวอักษร
- `REQUIRE_API_KEY=true`
- `ALLOWED_ORIGINS` ต้องตรงกับ origin ของ SPA (เช่น `https://flowmail.vercel.app,https://app.example.com`)
- `FLOWMAIL_DB_PATH` ชี้ไปยัง persistent volume (เช่น `/data/mailbox.db`)
- `VITE_API_BASE_URL` ต้องตั้ง **ตอน build SPA** ถ้า API ไม่ได้อยู่ origin เดียวกัน

## รันแบบ Docker Compose

```powershell
& "C:\Program Files\nodejs\npm.cmd" ci
Copy-Item .env.example .env
# แก้ .env ให้เป็น secret จริง
docker compose up -d --build
```

ตรวจสอบ:

```powershell
curl http://localhost:3000/api/health
curl http://localhost:3000/api/health/worker
```

## รันแบบ Vercel SPA + Backend แยก

1. ตั้ง `VITE_API_BASE_URL=https://api.example.com` ใน Vercel environment **ก่อน build**
2. ตั้ง `ALLOWED_ORIGINS=https://your-spa.vercel.app` บน backend
3. Deploy backend ในรูปแบบ persistent container/VPS; mount volume ที่ `/data`
4. Deploy worker จาก image เดียวกันด้วยคำสั่ง `npm run worker`
5. ตรวจ `/api/health` และ `/api/health/worker`

`vercel.json` มีไว้สำหรับ build SPA เท่านั้น; Vercel serverless ไม่เหมาะกับ SQLite persistence

## Migration / Backup / Restore

```powershell
# ตรวจ schema และ integrity (ต้อง version >= 3)
& "C:\Program Files\nodejs\npm.cmd" run migrate:check

# สำรองขณะระบบทำงานได้ (ใช้ SQLite VACUUM INTO)
& "C:\Program Files\nodejs\npm.cmd" run backup -- /data/backups/mailbox-$(Get-Date -Format yyyyMMddHHmmss).db

# ก่อน restore: หยุด API และ worker ทั้งคู่ แล้วค่อยรัน
& "C:\Program Files\nodejs\npm.cmd" run restore -- /data/backups/mailbox-....db --confirm
```

หมายเหตุสำคัญ:

- ไฟล์คีย์ `SecretCipher` อยู่ข้าง database (`<db-dir>/.secret.key`) หรือใช้ `RELAYBOX_ENCRYPTION_KEY` จาก secret manager; restore ต้องใช้คีย์ชุดเดิม
- `restore` ตรวจ `integrity_check` และตรวจ row counts ก่อน/หลัง staged copy แล้วจึง rename แทนของเดิม
- ลบ `-wal`/`-shm` เก่าหลัง restore (สคริปต์ทำให้แล้ว)
- Migration ของตารางใหม่ใช้ `CREATE TABLE IF NOT EXISTS`; กับ database เดิมที่ใช้ v2 อยู่ ระบบจะ apply v3 อัตโนมัติตอนเริ่มต้น

## Security Baseline ที่เปลี่ยนไป

- `POST /api/v1/session` แบบไม่มี credential ได้เฉพาะ scope `read`
- elevated scope ต้องส่ง `{ "passcode": "..." }` หรือ `{ "apiKey": "..." }`
- session เก็บใน SQLite มี hash, expiry, revoke (`POST /api/v1/session/logout`)
- rate limit เก็บใน SQLite ใช้ร่วมกันหลาย process
- `/api/admin/*` ต้องใช้ admin session (`kind='admin'`) จาก setup/login
- CORS allowlist + origin guard ปฏิเสธ state-changing cross-origin
- webhook validate ทั้ง hostname, resolved DNS (กัน DNS rebinding) และปิด redirect
- production ปฏิเสธ secret ค่าเริ่มต้นผ่าน `validateProductionEnv()`

## SMTP

- inbound bridge bind `127.0.0.1` โดยค่าเริ่มต้น; อย่า expose port 2525 สู่ public
- ต้อง terminate TLS ที่ MTA ด้านหน้า; เปิด `SMTP_AUTH_USER`/`SMTP_AUTH_PASS` ถ้าจำเป็น
- outbound relay ตั้งผ่าน `SMTP_OUTBOUND_*`

## Links

- `docs/HYBRID_PHASE0_BASELINE.md` — baseline ก่อนแก้ไข
- `docs/HYBRID_VERIFICATION_REPORT.md` — ผลทดสอบหลังแก้ไข
