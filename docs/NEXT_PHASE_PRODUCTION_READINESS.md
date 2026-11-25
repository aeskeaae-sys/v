# Next Phase Production Readiness & Operations Guide — Mailbox Enterprise (`RelayBox`)

**Evaluation Date**: 2026-11-24
**Target System**: RelayBox / Mailbox Enterprise (`v22.23.5` Node.js + SQLite + React SPA)

---

## 1. Production Readiness Decision: **CONDITIONAL GO**

### 1.1 Rationale (อ้างอิงจากหลักฐานการทดสอบจริง)
- **Ready / Verified**:
  - ระบบ Backend + SQLite Persistence (`node:sqlite` + WAL + AES-256-GCM encryption + Migrations) ทำงานเสถียรและข้อมูลยังคงอยู่ครบหลัง Restart (ยืนยันด้วย `integration.test.ts`)
  - Unit & Integration tests ผ่าน **23/23 รายการ**, TypeScript (`tsc --noEmit`) และ Vite Build ผ่าน **0 errors**
  - Browser E2E Verification ผ่านทุก Workflow หลัก, 0 Console Errors/Warnings, และ Responsive ครบ 5 ขนาดหน้าจอ (`overflowX: false`)
  - ระบบป้องกันความปลอดภัยหลัก (HMAC Webhook Signing, Replay Guard, SSRF Guard, XSS Iframe Sandbox, Scoped API Keys, Rate Limiting, CSV/Log Redaction) ทำงานได้จริงตามผลทดสอบ
- **Conditions Required Before Public Production Go-Live**:
  1. **Security Env**: ต้องตั้ง `REQUIRE_API_KEY=true`, `RELAYBOX_ENCRYPTION_KEY` (Secret Manager) และ `WEBHOOK_INBOUND_SECRET`
  2. **Access Control Boundary**: เนื่องจาก `POST /api/v1/session` ออก Session Token สำหรับหน้า Web Dashboard โดยไม่มีหน้า Login ขององค์กร ต้องวาง Web UI ไว้หลัง Corporate SSO / Reverse Proxy Auth (หรือ VPN)
  3. **Outbound SMTP Relay (ยังไม่ถูกกำหนดค่าใน Sandbox)**: ตัวแปร `SMTP_OUTBOUND_HOST`, `SMTP_OUTBOUND_PORT`, `SMTP_OUTBOUND_USER`, `SMTP_OUTBOUND_PASS` ปัจจุบันเป็นค่าว่าง — ระบบส่งข้อความภายในระหว่างกล่องใน RelayBox และบันทึกร่าง (`drafts` / `sent`) ได้จริง แต่หากต้องการส่งอีเมลออกไปโดเมนภายนอกจริง ต้องกำหนดค่า Relay Provider (เช่น SES, Postmark, Mailgun, SendGrid)
  4. **Custom Domain MX**: หากใช้โดเมนส่วนตัวแทน `api.mail.tm` ต้องตั้งค่า DNS MX Record และวาง MTA หน้าพอร์ต SMTP Inbound Bridge (`SMTP_PORT`)

---

## 2. Installation & Deployment Guide

### 2.1 Prerequisites
- Node.js `>= 22.0.0` (ต้องการ Built-in `node:sqlite`, ทดสอบจริงบน `v22.23.5`)
- `npm` `>= 10`
- Persistent volume สำหรับโฟลเดอร์ `.data/` (จัดเก็บ `mailbox.db`, `-wal`, `-shm`, และ `.master.key`)

### 2.2 Installation & Build Commands
```bash
# 1. Install dependencies
npm install

# 2. Verify types & tests
npm run lint
npm test

# 3. Build frontend SPA assets into dist/
npm run build

# 4. Run in Production (Express serves API + built dist/ on port 3000)
NODE_ENV=production npm start
```
*(หมายเหตุ: สำหรับโหมด Development ใช้ `npm run dev` ซึ่งรัน `tsx server.ts` พร้อม Vite middleware)*

### 2.3 Reverse Proxy (Nginx Example)
- Proxy HTTP/SSE traffic ไปยัง `http://127.0.0.1:3000`
- สำหรับ `/api/v1/events` (SSE) ต้องปิด Buffering:
  - `proxy_buffering off;`
  - `proxy_cache off;`
  - `proxy_read_timeout 3600s;`

---

## 3. Configuration Guide (Environment Variables)

อ้างอิงจาก `.env.example`:

| Variable | Default | Required in Prod | Description |
| :--- | :--- | :---: | :--- |
| `PORT` | `3000` | Recommended | พอร์ต HTTP/SPA Server |
| `RELAYBOX_ENCRYPTION_KEY` | *(auto `.data/.master.key`)* | **Yes** | Secret ≥ 32 ตัวอักษรสำหรับ AES-256-GCM master key |
| `REQUIRE_API_KEY` | `false` | **Yes (`true`)** | บังคับ `Authorization: Bearer` / `x-api-key` บน `/api/v1/*` |
| `WEBHOOK_INBOUND_SECRET` | *(empty)* | Recommended | HMAC-SHA256 secret สำหรับตรวจ `X-RelayBox-Signature` ขาเข้า |
| `SMTP_PORT` | `2525` | Optional | พอร์ต Local ESMTP Inbound Bridge (`127.0.0.1`) |
| `SMTP_AUTH_USER` / `SMTP_AUTH_PASS` | *(empty)* | Recommended | เปิดใช้ `AUTH PLAIN` / `AUTH LOGIN` บน SMTP Inbound Bridge |
| `SMTP_OUTBOUND_HOST` / `PORT` / `SECURE` / `USER` / `PASS` | *(empty)* | If sending external mail | ค่าเชื่อมต่อ Outbound SMTP Relay |
| `RETENTION_DAYS` | `30` | Optional | จำนวนวันเก็บข้อความและ Log ก่อนลบอัตโนมัติ |

---

## 4. REST API v1 Reference

Base URL: `/api/v1` (แนบ `Authorization: Bearer <token_or_api_key>` หรือ `x-api-key: <key>`)

| Method & Path | Scope | Description |
| :--- | :--- | :--- |
| `GET /api/health` | Public | ตรวจสุขภาพ Application, SQLite DB, Mail Provider, Sync Engine, Webhooks (ไม่มีข้อมูลลับ) |
| `POST /api/v1/session` | Public | ออก in-memory UI Session Token (Rate limit 60/min/IP) |
| `GET /api/v1/domains/validate?domain=...` | `read` | ตรวจ DNS MX Records จริง (`dns.resolveMx`) พร้อมรายการ MX และสถานะรองรับ |
| `GET/POST /api/v1/addresses` *(หรือ `/inboxes`)* | `read` / `write` | รายการกล่อง หรือสร้างกล่องใหม่ (`mode: live-mx \| webhook`, `provider: mail.tm \| webhook \| smtp`) |
| `PATCH /api/v1/addresses/:id` | `write` | แก้ไข `label`, `status` (`active\|paused\|error\|expired`), `ttl`, `webhookUrl` |
| `POST /api/v1/addresses/:id/switch` | `read` | สลับ Active inbox และบันทึก Event `address:switched` |
| `DELETE /api/v1/addresses/:id` | `write` | ลบกล่องและข้อความทั้งหมดแบบ Cascade |
| `POST /api/v1/inboxes/:id/sync` | `write` | Sync กล่อง Live MX ทันที |
| `GET /api/v1/messages` | `read` | ค้นหาข้อความรวมทุกกล่อง (`inboxId`, `folder`, `q`, `unread`, `starred`, `hasOtp`, `limit`, `offset`) |
| `GET /api/v1/inboxes/:id/messages` | `read` | ดึงข้อความในกล่องแบบแบ่งหน้าและกรองโฟลเดอร์ (`all\|inbox\|sent\|drafts\|spam\|trash`) |
| `GET /api/v1/inboxes/:id/latest` | `read` | ดึงข้อความล่าสุด + `otp` + `actionUrl` |
| `GET /api/v1/inboxes/:id/wait?timeout=15000` | `read` | Long-poll รออีเมลใหม่ที่ตรง `subject` / `from` |
| `POST /api/v1/messages` / `POST /api/v1/inbound` | `write` / `webhooks` | นำเข้าอีเมล (รองรับ Mailgun/SendGrid/Postmark payload, `X-RelayBox-Signature`, `X-Event-Id`) |
| `POST /api/v1/messages/send` | `write` | บันทึกร่าง (`mode: "drafts"`) หรือส่งอีเมลภายใน (`mode: "sent"`) |
| `PATCH /api/v1/messages/:id` | `write` | เปลี่ยน `read`, `starred`, หรือ `folder` |
| `POST /api/v1/messages/:id/restore` | `write` | กู้คืนอีเมลจาก `trash` / `spam` กลับเข้า `inbox` |
| `DELETE /api/v1/messages/:id?permanent=true` | `write` | ย้ายเข้า `trash` (default) หรือลบถาวร (`permanent=true`) |
| `GET /api/v1/otp` | `read` | รายการ OTP และ Verification Links ทั้งหมด (`inboxId`, `q`, `kind=all\|otp\|links`) |
| `GET/POST/DELETE /api/v1/webhooks` | `webhooks` | จัดการ Outbound Webhook Subscriptions (สร้าง Secret อัตโนมัติ) |
| `GET /api/v1/webhooks/deliveries` | `webhooks` | ดูประวัติการส่ง Webhook และ HTTP Status/Retry attempts |
| `GET /api/v1/smtp/status` | `read` | ดูสถานะ Inbound SMTP Bridge และ Outbound Relay |
| `POST /api/v1/smtp/test` | `admin` | ทดสอบ TCP/TLS + ESMTP `EHLO` Handshake จริง |
| `GET/POST/DELETE /api/v1/keys` | `read` / `admin` | จัดการ Scoped API Keys + Rate limits |
| `GET /api/v1/activity` & `/api/v1/activity/export` | `read` | ค้นหา/แบ่งหน้า Activity Logs และ Export `format=json\|csv` |
| `GET /api/v1/usage` | `read` | ดู API Usage & Latency Logs |
| `GET /api/v1/events` | `read` | Server-Sent Events (SSE) real-time updates |

---

## 5. Database Migration, Backup & Recovery Guide

### 5.1 Migrations
- Schema migrations อยู่ในอาร์เรย์ `MIGRATIONS` ใน `server/db.ts` และบันทึกประวัติในตาราง `schema_migrations`
- เมื่อเพิ่ม Schema ใหม่ ให้เพิ่ม Migration ลำดับถัดไป (`version: 2`, ...) ระบบจะรันใน Transaction (`BEGIN` / `COMMIT` / `ROLLBACK`) อัตโนมัติเมื่อเปิด `MailboxDatabase`
- ข้อมูล JSON เดิม (`.data/flowmail-store.json`) จะถูก Import อัตโนมัติครั้งเดียวเมื่อตาราง `inboxes` ว่างเปล่า

### 5.2 Backup & Recovery (SQLite WAL Safe Procedure)
- เนื่องจากฐานข้อมูลเปิด WAL Mode (`mailbox.db`, `mailbox.db-wal`, `mailbox.db-shm`) **ห้ามก๊อปปี้เฉพาะไฟล์ `.db` ขณะเขียนข้อมูลโดยไม่ทำ Checkpoint หรือใช้ Online Backup API**
- วิธีสำรองข้อมูลที่ปลอดภัย:
  ```bash
  # วิธีที่ 1: ใช้ Node/SQLite VACUUM INTO เพื่อสร้างไฟล์ Snapshot ที่สมบูรณ์ในขณะระบบทำงาน
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(".data/mailbox.db"); db.exec("VACUUM INTO '\''backup/mailbox-" + Date.now() + ".db'\''");'
  ```
- **สำคัญ**: สำรองค่า `RELAYBOX_ENCRYPTION_KEY` (หรือ `.data/.master.key`) คู่กับ Backup เสมอ มิฉะนั้นจะไม่สามารถถอดรหัส `credentials_enc` และ `secret_enc` ได้
- **Recovery**: หยุด Node process -> แทนที่ `.data/mailbox.db` (และลบไฟล์ `.data/mailbox.db-wal`, `.data/mailbox.db-shm` เก่า) -> ตรวจสอบ Environment variable `RELAYBOX_ENCRYPTION_KEY` -> สตาร์ทระบบและตรวจ `GET /api/health`

---

## 6. Security Operations Checklist
- [ ] ตั้ง `REQUIRE_API_KEY=true` ใน Production
- [ ] กำหนด `RELAYBOX_ENCRYPTION_KEY` แบบสุ่ม 256-bit ขึ้นไป
- [ ] กำหนด `WEBHOOK_INBOUND_SECRET` และตรวจสอบ `X-RelayBox-Signature` ฝั่งรับ/ส่ง
- [ ] ป้องกัน Web UI ด้วย Reverse Proxy Authentication
- [ ] ตั้งค่า `SMTP_AUTH_USER` / `SMTP_AUTH_PASS` หากเปิดรับ SMTP จาก Host อื่นใน Private Network
- [ ] ตรวจสอบ `/api/health` เป็นระยะเพื่อติดตามสถานะ DB, Sync และ Live MX
