# Phase 0 — Baseline Repository Audit Report (`Mailbox Enterprise / RelayBox`)

**Audit Date**: 2026-11-24
**Workspace**: `/app/applet`
**Node.js Runtime**: `v22.23.5` (with built-in `node:sqlite`)

---

## 1. โครงสร้างโปรเจกต์และสถาปัตยกรรมปัจจุบัน

- **Frontend**: React 19 + Vite 8 + Tailwind CSS v4 (`@tailwindcss/vite`) + Lucide Icons
  - Entry: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`
  - API Client: `src/api/client.ts` (ใช้ `Authorization: Bearer` in-memory token จาก `POST /api/v1/session` และ SSE `/api/v1/events`)
  - Utilities: `src/utils/format.ts`, `src/utils/format.test.ts`
  - Views/Components (`src/components/`):
    - `AppSidebar.tsx`: เมนูภาษาไทย 7 เมนู (แดชบอร์ด, สร้างอีเมล, กล่องจดหมาย, ศูนย์ OTP, บัญชีของฉัน, API & Webhooks, บันทึกกิจกรรม) + Mobile Drawer + Collapsible rail
    - `DashboardView.tsx`: Hero + Real stats 2x2 + Recent messages + Quick Start Guide
    - `CreateAddressView.tsx`: สร้างกล่อง Live MX หรือ Webhook / SMTP
    - `OtpCenterView.tsx`: แสดงข้อความที่มี OTP หรือลิงก์ยืนยันตัวตน
    - `AddressesView.tsx`: แสดงรายการกล่องทั้งหมด สลับ/คัดลอก/ลบ
    - `ActiveAddressBar.tsx`, `MessageList.tsx`, `MessageInspector.tsx`: แถบควบคุม Inbox, ค้นหา, ตัวกรอง (`ทั้งหมด`, `ยังไม่อ่าน`, `ติดดาว`, `รหัส OTP`), มุมมอง `List | Split`, และ Email HTML Reader ใน `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">`
    - `ApiDocsView.tsx`: Code snippets, API Key manager, Outbound Webhook config, REST reference
    - `ActivityLogView.tsx`: ตารางแสดงกิจกรรมล่าสุด 200 รายการ
- **Backend**: Express 4 (`server.ts`, รันผ่าน `tsx server.ts`)
  - `server/mailtm.ts`: เชื่อมต่อ Mail.tm API (`https://api.mail.tm`) จริง (ทดสอบแล้วได้ HTTP 200 domain `euploading.com`)
  - `server/smtp.ts`: Embedded ESMTP listener (`127.0.0.1:2525`) สำหรับรับเมลเข้า Webhook/SMTP domains
  - `server/parser.ts`: Email address parser, HTML stripping, OTP/Link extraction, HTML sanitizer, Outbound Webhook SSRF guard
  - `server/store.ts`: `FlowMailStore` เก็บข้อมูลใน Memory Maps + เขียนไฟล์ JSON (`.data/flowmail-store.json`), SSE broadcaster, long-poll waiters
- **Shared**: `shared/types.ts`

---

## 2. ฟีเจอร์ที่มีอยู่จริงและใช้งานได้

1. สร้าง/ลบ/ล้างกล่องจดหมายชั่วคราวแบบ **Live MX** (`api.mail.tm`) และ **Webhook/SMTP**
2. รับอีเมลจริงจากภายนอกผ่าน Mail.tm polling (ทุก 5 วินาทีเมื่อมี SSE subscriber และกดเช็คเมลทันที)
3. รับอีเมลผ่าน REST API (`POST /api/v1/inbound`, `POST /api/v1/messages`) และ local ESMTP port `2525`
4. Long-poll wait (`GET /api/v1/inboxes/:id/wait`) และ Real-time SSE (`/api/v1/events`)
5. สกัดรหัส OTP และ Verification URLs อัตโนมัติ, แสดงผลใน `MessageInspector` และ `OtpCenterView`
6. แสดงผล HTML Email ใน `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` พร้อม `<base target="_blank">` ที่กดปุ่ม/ลิงก์เปิดแท็บใหม่ได้
7. Unit Tests เดิม 15 รายการ (`server/parser.test.ts`, `server/store.test.ts`, `src/utils/format.test.ts`)

---

## 3. ฟีเจอร์ที่ยังไม่สมบูรณ์ / API และระบบที่ขาด

1. **Database Schema, Migrations, Indexes และ Retention**:
   - ปัจจุบันใช้ JSON file (`.data/flowmail-store.json`) ไม่มี Relational Database, ไม่มี SQL Indexes, ไม่มี Migration versioning, ไม่มี Pagination (โหลดทุก message เข้า memory)
   - สามารถใช้ **SQLite (`node:sqlite` Built-in ใน Node v22.23.5)** สร้างระบบ Database จริงพร้อม Schema, Migrations, Foreign Keys, Indexes, WAL mode และ Backup/Recovery โดยไม่ต้องเพิ่ม external infrastructure
2. **Database Encryption for Secrets**:
   - **พบช่องโหว่**: `remotePassword` และ `remoteToken` ของบัญชี Mail.tm ถูกบันทึกลง `.data/flowmail-store.json` แบบ Plaintext
3. **Mailbox Folders & Email Lifecycle**:
   - ขาดโฟลเดอร์มาตรฐาน **Inbox, Sent, Drafts, Spam, Trash** (ปัจจุบันมีแค่ all/unread/starred/codes และลบถาวรทันที ไม่มี Soft-delete / Trash restore และไม่มีระบบ Draft/Sent/Spam classification)
   - ขาดการแก้ไขข้อมูลบัญชี (Edit label / TTL / status) ใน `AddressesView` และขาดข้อมูลสถานะ Sync & Provider details
4. **Email Processing Engine**:
   - `server/smtp.ts` ยังไม่รองรับ **MIME Multipart** (`multipart/alternative`, `multipart/mixed`), `Content-Transfer-Encoding` (`base64`, `quoted-printable`), และ Attachments parsing
   - OTP Detection ยังไม่ครอบคลุม Alphanumeric OTP และยังตรวจจับตัวเลขทั่วไป/ราคา/วันที่บางรูปแบบพลาดได้
   - ขาด **Spam Classification**, **Duplicate Message Detection** (Content/Message-ID hash สำหรับ webhook/SMTP), **Email Threading** (`In-Reply-To` / `References` / normalized subject `threadId`), และ **Message Search Index (FTS/indexed lookup)**
5. **Real Email Integration & Validation**:
   - Live MX ยังไม่ตรวจ **DNS MX Records** (`dns.resolveMx`) ของโดเมน
   - **Webhook System**: ขาด Inbound Webhook Signature Verification (`X-RelayBox-Signature` / HMAC-SHA256), Secret management, Duplicate Event Prevention (`X-Event-Id`), Retry mechanism (exponential backoff) และ Delivery Logs UI/API
   - **SMTP Integration**: ขาดการแยก inbound reception vs outbound SMTP relay configuration, TLS status, Authentication (`AUTH PLAIN`/`LOGIN`) และ Connection Testing endpoint (`POST /api/v1/smtp/test`)
6. **API v1 Endpoints & Scopes & Rate Limiting**:
   - ขาด REST endpoints มาตรฐานตาม Requirement: `GET/POST/PATCH /api/v1/addresses`, `GET /api/v1/messages`, `GET /api/v1/messages/:id`, `GET /api/v1/otp`, `POST/GET /api/v1/webhooks`, `GET /api/v1/activity`, `GET /api/health`
   - API Keys ไม่มี **Permission Scopes** (`read`, `write`, `webhooks`, `admin`), ไม่มี **Rate Limiting** per key/IP, และไม่มี **API Usage Logs**
7. **Security Findings**:
   - **Plaintext Credentials on Disk**: Mail.tm credentials ไม่ได้เข้ารหัส (AES-256-GCM)
   - **Open Settings/Key Mutation**: เมื่อ `requireApiKeyForExternal = false` endpoint อ่อนไหวอย่าง `PATCH /api/v1/settings`, `POST /api/v1/keys`, `DELETE /api/v1/keys/:id` เปิดให้เรียกโดยไม่มี scope check
   - **Activity Log Leakage**: Activity detail เคยบันทึก extracted OTP (`Extracted OTP: 749210`) หรือ URL เต็มไว้ใน Log (ควร redact OTP code บางส่วนและ token query params)
   - **HTML Email Sanitization**: ควรกรอง `<svg>`, `<object>`, `<embed>`, `<iframe`, `<form>`, `<input>`, `srcdoc`, CSS `expression()`/`javascript:` เพิ่มเติมให้รัดกุม
   - **SMTP Memory DoS**: `smtp.ts` ยังไม่จำกัด max message size (`5 MB`) ระหว่างรับ stream และไม่มี socket idle timeout
   - **Missing Security Headers**: Express ยังไม่มี HTTP security headers (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, ฯลฯ)
8. **Activity Log**:
   - ยังขาด event types (`address:switched`, `email:read`, `otp:detected`, `webhook:created`, `webhook:failed`, `inbox:synced`, `auth:failed`/`auth:success`), ตัวกรอง Search / Date Range / Event Type / Status, Pagination และ Export (JSON/CSV)
9. **Testing & Scripts**:
   - `package.json` ไม่มี script `"test"`
   - มีเพียง unit tests 15 ข้อ ยังไม่มี Integration tests, Security tests, และ E2E regression suite

---

## 4. ส่วนที่นำกลับมาใช้ได้ (Reusable Assets)

- Dark-Navy UI Shell, Sidebar, Header และ Thai localization ทั้ง 7 หน้าจอ
- `server/mailtm.ts` Live MX integration จริง
- `server/parser.ts` URL SSRF validation (`validateOutboundWebhookUrl`) และ `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` + `<base target="_blank">`
- 15 Unit tests เดิม
