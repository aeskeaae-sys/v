# Next Phase Security Report — Mailbox Enterprise (`RelayBox`)

**Assessment Date**: 2026-11-24
**Scope**: Full-Stack Codebase (`/server.ts`, `/server/*.ts`, `/src/**/*.ts(x)`, `/shared/types.ts`)

---

## 1. Security Posture & Controls Implemented

| Security Domain | Control Implemented | Verification Evidence |
| :--- | :--- | :--- |
| **Data-at-Rest Encryption** | `SecretCipher` (`AES-256-GCM`, 12-byte random IV, 16-byte Auth Tag) เข้ารหัส Mail.tm credentials (`inboxes.credentials_enc`) และ Webhook signing secrets (`webhooks.secret_enc`) ใช้ Key จาก `RELAYBOX_ENCRYPTION_KEY` หรือ `.data/.master.key` (`0600`) | `server/crypto.ts`, `server/crypto.test.ts` (Tamper detection passed) |
| **SQL Injection Prevention** | ทุก SQL Statement ใน `MailboxDatabase` ใช้ Parameterized Prepared Statements (`?` bindings) ผ่าน `node:sqlite` `DatabaseSync` | `server/db.ts` |
| **API Key Storage & Verification** | API Keys เก็บเป็น SHA-256 hash เท่านั้น ไม่เก็บ Plaintext; ตรวจสอบด้วย `crypto.timingSafeEqual` | `server/store.ts`, `server/store.test.ts` |
| **RBAC / API Scopes** | บังคับ Scope (`read`, `write`, `webhooks`, `admin`) บนทุก Route ภายใต้ `/api/v1/*` ผ่าน `requireScope(...)` | `server.ts`, `server/integration.test.ts` (`403 INSUFFICIENT_SCOPE`) |
| **Rate Limiting & Abuse Protection** | Sliding-window rate limiting ต่อ API Key (`10–2000` req/min) หรือ IP, คืน HTTP `429` พร้อม `X-RateLimit-*` และ `Retry-After` headers; Session endpoint จำกัด `60/min` | `server.ts`, `server/integration.test.ts` (`429 RATE_LIMITED`) |
| **Webhook Integrity & Replay Guard** | รองรับการตรวจสอบ `X-RelayBox-Signature` (`HMAC-SHA256` + Timestamp tolerance `300s` + `timingSafeEqual`) และกัน Replay ผ่าน `webhook_seen_events` (`X-Event-Id` / `Idempotency-Key`) | `server/crypto.ts`, `server.ts`, `server/integration.test.ts` (`401` / `200 duplicate`) |
| **Outbound SSRF Protection** | `validateOutboundWebhookUrl` บล็อก URL ที่ไม่ใช่ `http:`/`https:`, localhost, IPv4 private/loopback/link-local (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`), และ IPv6 loopback/ULA (`::1`, `fc00::/7`, `fe80::/10`) | `server/parser.ts`, `server/parser.test.ts` |
| **XSS & Email Rendering Sandbox** | Server-side (`sanitizeEmailHtmlForSandbox`) และ Client-side (`prepareSandboxedEmailHtml`) ลบ `<script>`, `<svg>`, `<iframe`, `<object>`, `<embed>`, `<form>`, `<input>`, `srcdoc`, inline `on*`, `javascript:` และเรนเดอร์ใน `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` พร้อม Strict CSP (`default-src 'none'; script-src 'none'`) | `server/parser.ts`, `src/utils/format.ts`, `src/components/MessageInspector.tsx` |
| **SMTP Hardening** | Local ESMTP Listener (`127.0.0.1`) จำกัด `MAX_MESSAGE_BYTES = 5 MB`, `SOCKET_IDLE_MS = 60s`, Command line buffer limit `64 KB`, และรองรับ `AUTH PLAIN`/`AUTH LOGIN` (เมื่อตั้ง `SMTP_AUTH_USER` & `SMTP_AUTH_PASS`) ด้วย `timingSafeEqual` | `server/smtp.ts` |
| **Attachment Hardening** | `sanitizeAttachmentFilename` ลบ Path traversal (`../`, `..\\`); `validateAttachment` บล็อกไฟล์ Executable (`.exe`, `.bat`, `.cmd`, `.msi`, `.ps1`, `.sh`, ฯลฯ) และขนาดเกินเกณฑ์ | `server/parser.ts`, `server/store.ts` |
| **Audit Log Redaction** | OTP ที่บันทึกใน Activity Log ถูก Mask (`739104` -> `73****`) และ Token ใน URL ถูกแทนด้วย `[REDACTED]` | `server/crypto.ts`, `server/integration.test.ts`, Live UI inspection |
| **HTTP Security Headers** | ปิด `x-powered-by`, ตั้งค่า `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-XSS-Protection: 0`, และ `Cache-Control: no-store` บน `/api/*` | `server.ts`, `server/integration.test.ts` |

---

## 2. Vulnerabilities Identified & Remediated Since Phase 0 Audit

1. **Plaintext Mail.tm Credentials on Disk** -> **FIXED**: ย้ายมาเก็บใน SQLite `inboxes.credentials_enc` ที่เข้ารหัสด้วย AES-256-GCM
2. **OTP Code Exposure in Activity Logs & Exports** -> **FIXED**: ใช้ `redactOtpCode` ก่อนบันทึกลงตาราง `activities` และทดสอบยืนยันในไฟล์ CSV Export
3. **Unauthenticated Inbound Webhook Replay & Spoofing** -> **FIXED**: เพิ่ม HMAC-SHA256 (`WEBHOOK_INBOUND_SECRET`) และตาราง `webhook_seen_events`
4. **SMTP Unbounded Memory Buffer** -> **FIXED**: จำกัดขนาด `DATA` Stream ไม่เกิน `5 MB` และ Idle timeout `60s`
5. **Flat API Key Permissions** -> **FIXED**: เพิ่มระบบ Scopes (`read`, `write`, `webhooks`, `admin`) และ Per-key Rate Limiting

---

## 3. Residual Risks & Operational Requirements for Production

| Severity | Finding / Condition | Required Mitigation Before Public Internet Exposure |
| :---: | :--- | :--- |
| **High** | **`REQUIRE_API_KEY` defaults to `false`** (Open Access mode สำหรับ Dev/Preview) | ใน Production **ต้องตั้ง `REQUIRE_API_KEY=true`** ใน Environment Variables เพื่อบังคับ Authentication บน `/api/v1/*` |
| **Medium** | **Public Web UI Session Bootstrap (`POST /api/v1/session`)** ออก Token ให้เบราว์เซอร์โดยไม่ต้อง Login (เนื่องจากยังไม่มี Multi-user Login/SSO UI ใน Scope นี้) | หากเปิดระบบให้เข้าถึงจากอินเทอร์เน็ตสาธารณะ ควรวางหลัง Reverse Proxy Auth (เช่น Cloudflare Access / IAP / Nginx Basic+OIDC) หรือเพิ่ม User Login |
| **Medium** | **`RELAYBOX_ENCRYPTION_KEY` optional fallback**: หากไม่ตั้งค่า ระบบจะสร้าง `.data/.master.key` บนดิสก์เครื่อง | ใน Production ควรตั้ง `RELAYBOX_ENCRYPTION_KEY` (ความยาว ≥ 32 ตัวอักษรสุ่ม) ผ่าน Secret Manager และเก็บแยกจากดิสก์ฐานข้อมูล |
| **Low** | **Rate Limit Buckets & UI Session Tokens อยู่ใน Memory (`Map`/`Set`)**: เมื่อ Restart server หรือ Scale หลาย Instance ค่า Bucket จะรีเซ็ต | เหมาะกับ Single-instance SQLite architecture; หาก Scale เป็น Multi-instance ให้ย้าย Rate limit & Session store ไปใช้ Redis |
| **Low** | **Local SMTP Bridge รับ Traffic แบบ Unencrypted Plaintext บน `127.0.0.1:2525`** | ห้ามเปิดพอร์ต `2525` ออกสู่อินเทอร์เน็ตโดยตรงโดยไม่ผ่าน TLS-terminating MTA (เช่น Postfix / Haraka) |
