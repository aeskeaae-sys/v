# Next Phase Implementation Report — Mailbox Enterprise (`RelayBox`)

**Report Date**: 2026-11-24
**Workspace**: `/app/applet`
**Runtime**: Node.js `v22.23.5` (with `node:sqlite`), Express `4.21.2`, React `19.0.1`, Vite `8.3.0`, Tailwind CSS `v4.3.3`

---

## 1. Executive Summary

โปรเจกต์ **RelayBox / Mailbox Enterprise** ได้รับการยกระดับจากระบบจัดเก็บไฟล์ JSON ในหน่วยความจำ มาเป็นแพลตฟอร์มจัดการกล่องอีเมลแบบ Full-Stack ที่มีฐานข้อมูล **SQLite (`node:sqlite` + WAL Mode)** พร้อมระบบ Schema Migrations, การเข้ารหัสข้อมูลลับแบบ **AES-256-GCM**, การตรวจ DNS MX จริง, SMTP Inbound Bridge รองรับ MIME Multipart + Auth, Webhook HMAC-SHA256 Signing & Retry, API Scopes + Rate Limiting และ UI ภาษาไทย 7 หน้าจอที่คงเอกลักษณ์ Dark-Navy (`#0b0f19` / `#0e1422` / `#121929` / `#637bff`) อย่างครบถ้วน

---

## 2. Architecture & Database Layer (`server/db.ts`, `shared/types.ts`)

### 2.1 SQLite Schema & Migrations
- สร้างคลาส `MailboxDatabase` ใน `server/db.ts` รองรับทั้งไฟล์ `.data/mailbox.db` (เปิด `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA synchronous = NORMAL`) และ `:memory:` สำหรับ Unit/Integration tests
- ระบบ `schema_migrations` (`v1_initial_enterprise_schema`) ครอบคลุม 9 ตารางหลัก:
  1. `inboxes` — เก็บข้อมูลกล่องจดหมาย, `provider` (`mail.tm | webhook | smtp`), `status` (`active | paused | error | expired`), `mx_verified`, `last_synced_at`, `sync_error`, และ `credentials_enc`
  2. `messages` — รองรับโฟลเดอร์ `inbox | sent | drafts | spam | trash`, `thread_id`, `content_hash`, `spam_score`, `spam_reasons_json`, `deleted_at` พร้อม Indexes (`idx_messages_inbox_folder_date`, `idx_messages_remote`, `idx_messages_hash`, `idx_messages_thread`, `idx_messages_received`)
  3. `api_keys` — เก็บ SHA-256 `key_hash`, `scopes_json`, `rate_limit_per_min`
  4. `webhooks` — เก็บ URL และ `secret_enc` (เข้ารหัส AES-256-GCM)
  5. `webhook_deliveries` — บันทึกประวัติการส่งออก (`delivered | retrying | failed`, `http_status`, `attempts`, `error`)
  6. `webhook_seen_events` — ป้องกัน Replay / Duplicate Event (`X-Event-Id` / `Idempotency-Key`)
  7. `activities` — บันทึก Audit Trail พร้อม `status` (`success | warning | error | info`) และ Indexes ตามเวลา/ประเภท
  8. `api_usage_logs` — บันทึก Latency, HTTP Status, Method, Path และ Key Prefix ของคำขอ `/api/v1/*`
  9. `settings` — เก็บค่า Config เช่น `requireApiKey` และ `retentionDays`
- **Legacy Migration**: รองรับการ Import ข้อมูลเดิมจาก `.data/flowmail-store.json` อัตโนมัติเมื่อตาราง `inboxes` ยังว่าง (พร้อม Flag `legacyJsonPath: null` สำหรับ Test Isolation)
- **Automatic Retention**: ทำงานแบบอัตโนมัติตามค่า `RETENTION_DAYS` (ค่าเริ่มต้น `30` วัน)

---

## 3. Core Backend Capabilities

### 3.1 Cryptography & Redaction (`server/crypto.ts`)
- **`SecretCipher`**: เข้ารหัส `credentials_enc` (Mail.tm password/JWT) และ `secret_enc` (Webhook signing secrets) ด้วย `AES-256-GCM` (`v1:<iv>:<tag>:<ciphertext>`) โดยใช้ Master Key จาก `RELAYBOX_ENCRYPTION_KEY` หรือ `.data/.master.key` (mode `0600`)
- **Webhook Signing**: `signWebhookPayload` และ `verifyWebhookSignature` สร้าง/ตรวจสอบ Header `X-RelayBox-Signature: t=<unix>,v1=<hmac_sha256>` ด้วย `crypto.timingSafeEqual` พร้อม Timestamp tolerance window (`300` วินาที)
- **Log Redaction**: `redactOtpCode` (`739104` -> `73****`) และ `redactSensitiveUrl` (ซ่อน Query parameters ประเภท `token`, `code`, `auth`, `secret`, `sig`, `password`)

### 3.2 Email Parsing, MIME, OTP, Spam & Sandbox (`server/parser.ts`)
- **MIME Multipart Parser (`parseMimeRawEmail`)**: รองรับ `multipart/alternative`, `multipart/mixed`, `Content-Transfer-Encoding` (`base64`, `quoted-printable`), Header folding และ Attachment filename sanitization
- **Dangerous Attachment Blocking (`validateAttachment`)**: บล็อกนามสกุลไฟล์ปฏิบัติการอันตราย (`.exe`, `.bat`, `.cmd`, `.msi`, `.scr`, `.vbs`, `.js`, `.ps1`, `.sh` ฯลฯ) และจำกัดขนาดไฟล์สูงสุด
- **OTP & Verification Extraction (`extractOtpCodes`, `extractLinks`)**: สกัดรหัส OTP ทั้งภาษาไทย/อังกฤษ ตัวเลข 4–8 หลัก, แบบขีดกลาง (`931-408`), และ Alphanumeric (`AB12CD90`) พร้อมกรอง False positives (ปี ค.ศ., ราคา/สกุลเงิน, รหัสใบแจ้งหนี้, เบอร์โทร)
- **Spam Classification (`classifySpam`) & Threading (`computeThreadId`)**: ให้คะแนน Spam จาก Phishing heuristics, SPF/DKIM failure และคำต้องสงสัย หากคะแนนถึงเกณฑ์จะจัดเข้าโฟลเดอร์ `spam` อัตโนมัติ
- **HTML Sandbox (`sanitizeEmailHtmlForSandbox`)**: ลบ `<script>`, `<noscript>`, `<iframe>`, `<object>`, `<embed>`, `<svg>`, `<form>`, `<input>`, `srcdoc`, `on*` event handlers, `javascript:` URLs พร้อม注入 Strict CSP และ `<base target="_blank">`

### 3.3 DNS MX, Mail.tm Sync, Webhook & SMTP Bridge
- **Real DNS Validation (`server/dns.ts`)**: `GET /api/v1/domains/validate` เรียก `dns.resolveMx(domain)` จริงพร้อม In-memory TTL cache
- **Live MX (`server/mailtm.ts` + `server/store.ts`)**: สร้างบัญชี Mail.tm จริง, ดึงข้อความขาเข้า, อัปเดต `lastSyncedAt` / `syncError` และกระจายเหตุการณ์ผ่าน SSE (`/api/v1/events`) และ Long-poll (`/api/v1/inboxes/:id/wait`)
- **Webhook Engine (`server.ts`)**: ส่งออก `X-RelayBox-Signature`, `X-RelayBox-Event-Id`, Retry 3 ครั้ง (`300ms`, `900ms`), ตรวจ SSRF (`validateOutboundWebhookUrl`), และบันทึกผลลง `webhook_deliveries`
- **ESMTP Bridge (`server/smtp.ts`)**: ฟังพอร์ต `127.0.0.1:2525` (กำหนดผ่าน `SMTP_PORT`), รองรับ `AUTH PLAIN` / `AUTH LOGIN` (เมื่อตั้ง `SMTP_AUTH_USER` + `SMTP_AUTH_PASS`), จำกัดขนาดข้อความสูงสุด `5 MB`, Idle socket timeout `60s`, และ Endpoint ทดสอบ Handshake จริง `POST /api/v1/smtp/test`

### 3.4 API v1 Endpoints, Scopes & Rate Limiting (`server.ts`)
- Scopes: `read`, `write`, `webhooks`, `admin`
- Sliding-window rate limiting ต่อ API Key (`rateLimitPerMin` ตั้งแต่ `10–2000` req/min) พร้อม Response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` และรหัส `401` / `403` / `429`
- Health Check `GET /api/health` รายงานสถานะจริงของ Application, Database (SQLite + Migrations), Email Provider, Synchronization Engine และ Webhook Processing โดยไม่เปิดเผย Secrets

---

## 4. Frontend Views & Interactive Workflows (`src/App.tsx`, `src/api/client.ts`, `src/components/*`)

| Component | Enhancements Implemented |
| :--- | :--- |
| `DashboardView.tsx` | คง Hero และ Stats 2x2; เพิ่ม Quick Actions, Live System Health Badges (`/api/health`) และ Recent OTP Quick-Copy Cards |
| `CreateAddressView.tsx` | เลือก Provider (`Live MX`, `Webhook`, `SMTP Bridge`) และปุ่ม `ตรวจสอบ DNS MX` จริงผ่าน `/api/v1/domains/validate` |
| `MessageList.tsx` | แท็บโฟลเดอร์ครบ 5 โฟลเดอร์ (`กล่องเข้า`, `ส่งแล้ว`, `ร่าง`, `สแปม`, `ถังขยะ`), ตัวกรองย่อย, ปุ่ม `เขียนอีเมล` และปุ่ม Restore / Delete |
| `MessageInspector.tsx` | แบนเนอร์แจ้งเตือน Spam + คะแนน + เหตุผล, ปุ่ม `กู้คืนเข้ากล่อง`, Trash-aware Delete, และ `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` |
| `OtpCenterView.tsx` | ค้นหาแบบ Real-time, กรองตามบัญชี (`ทุกบัญชี` หรือระบุกล่อง) และประเภท (`ทั้งหมด` \| `รหัส OTP` \| `ลิงก์ยืนยัน`) ผ่าน `GET /api/v1/otp` |
| `AddressesView.tsx` | แสดง `provider`, `status`, `MX OK`, `lastSyncedAt`, `syncError`, ปุ่ม Sync ทันที และ Modal แก้ไข (`label`, `status`, `ttl`, `webhookUrl`) |
| `ApiDocsView.tsx` | จัดการ Scoped API Keys + Rate limit, Webhook Registry + Delivery Logs, SMTP Bridge Status + Handshake Tester, API Usage Logs และเอกสาร REST v1 |
| `ActivityLogView.tsx` | ครอบคลุม Activity Event Types ทั้ง 19 ประเภท (`EVENT_LABELS`), ค้นหา, กรองประเภท/สถานะ/ช่วงวันที่, Pagination และ Export JSON/CSV แบบ Authenticated Blob |
| `App.tsx` | เชื่อมต่อ State + SSE Deduplication (ป้องกัน duplicate React key เมื่อ Save Draft/Send), Compose/Draft Modal และ Cross-inbox message navigation |
