# Next Phase Test Report — Mailbox Enterprise (`RelayBox`)

**Test Execution Date**: 2026-11-24
**Workspace**: `/app/applet`
**Environment**: Linux container, Node.js `v22.23.5`, Chromium headless via `playwright-cli`

---

## 1. Test Summary Overview

| Suite / Verification Gate | Command / Tool | Result | Details |
| :--- | :--- | :--- | :--- |
| **TypeScript Typecheck** | `npm run lint` (`tsc --noEmit`) | **PASS** | 0 errors |
| **Production Bundle Build** | `npm run build` (`vite build`) | **PASS** | 0 errors |
| **Unit + Integration Suite** | `npm test` (`tsx --test server/*.test.ts src/utils/*.test.ts`) | **PASS** | **23 / 23 passed**, **0 failed** |
| **Browser E2E & Responsive** | `playwright-cli` (`http://localhost:3000`) | **PASS** | **0 Console Errors, 0 Warnings**, 5 viewports verified (`overflowX: false`) |

---

## 2. Automated Unit & Integration Tests (`23/23` Passed)

### 2.1 Cryptography & Redaction (`server/crypto.test.ts` — 3 tests)
- `SecretCipher`: เข้ารหัส `v1:...`, ถอดรหัสข้าม instance จาก `.master.key`, รองรับ legacy plaintext passthrough, และคืนค่าว่างเมื่อ ciphertext ถูกดัดแปลง (AES-256-GCM auth tag verification)
- Webhook HMAC: `signWebhookPayload` & `verifyWebhookSignature` ยืนยันลายเซ็นถูกต้อง, ปฏิเสธ payload ที่ถูกแก้ไข, ปฏิเสธ timestamp นอก tolerance window, และปฏิเสธ header ที่ขาดหาย
- Audit Redaction: `redactOtpCode('482910') === '48****'` และ `redactSensitiveUrl` ซ่อนค่า `token` ใน URL query

### 2.2 Email Parser, MIME, Sandbox & Spam (`server/parser.test.ts` — 9 tests)
- `normalizeEmailAddress`: รองรับ plain/display-name และปฏิเสธโดเมนผิดรูปแบบ
- `extractOtpCodes`: สกัดรหัส 5–6 หลัก, hyphenated (`931-408`), ภาษาไทย และ alphanumeric (`AB12CD90`) พร้อมละเว้นปี (`2026`), ราคา (`$49.00`) และรหัสใบแจ้งหนี้ (`#INV-2026-0842`)
- `extractLinks` & `extractArtifacts`: จำแนก `verification` / `reset` / `general`, กรอง `javascript:`, และเลือก `primaryOtp` + `primaryActionUrl`
- `stripHtmlToText` & `sanitizeEmailHtmlForSandbox`: ลบ `<script>`, `<svg>`, `<form>`, `srcdoc`, inline `onclick`, `javascript:` และบังคับ CSP `img-src data:;`
- `validateOutboundWebhookUrl`: บล็อก Private/Loopback/Metadata IPs (`127.0.0.1`, `localhost`, `169.254.169.254`) และโปรโตคอลที่ไม่ใช่ HTTP/HTTPS
- `parseMimeRawEmail`: ถอดรหัส `multipart/mixed`, `quoted-printable`, `base64`, ป้องกัน path traversal ในชื่อไฟล์แนบ (`../../etc/invoice.pdf` -> `invoice.pdf`), และปฏิเสธไฟล์ `.exe` หรือไฟล์ขนาดเกินลิมิต
- `classifySpam` & `computeThreadId`: แยกอีเมลปกติ vs Phishing/SPF-fail และรวมอีเมลตอบกลับ (`Re: Fwd:`) เข้า `threadId` เดียวกัน

### 2.3 Store & Folder Lifecycle (`server/store.test.ts` — 6 tests)
- สร้างกล่อง Webhook & Live MX พร้อมป้องกันข้อมูล `credentials` รั่วใน public view
- Deduplication ด้วย `remoteId`, อัปเดต `read` / `starred`, และ `autoCreateInbox`
- `waitForMessage` long-polling รอข้อความตรงเงื่อนไขสำเร็จ
- API Key hashing + `timingSafeEqual` verification + revocation
- โฟลเดอร์ครบ (`inbox`, `sent`, `drafts`, `spam`, `trash`), Internal delivery ระหว่างกล่องในระบบ, Soft-delete -> Restore -> Permanent delete, การบล็อก `.exe` attachment, และการจัดเข้าโฟลเดอร์ `spam`

### 2.4 Full-Stack API & Persistence Integration (`server/integration.test.ts` — 2 tests)
- **Full Lifecycle + SQLite Restart Persistence**:
  - `GET /api/health` (`200`), `POST /api/v1/session`, สร้าง/แก้ไข/สลับกล่อง `/api/v1/addresses`
  - ส่งอีเมล RFC-5321 จริงเข้า Local ESMTP Socket (`127.0.0.1:<ephemeral_port>`) -> สกัด OTP `842910` -> Query `/api/v1/otp`
  - Compose Draft (`/api/v1/messages/send`), Soft-delete -> Restore, ทดสอบ `POST /api/v1/smtp/test` (`200`)
  - Export CSV (`/api/v1/activity/export?format=csv`) และยืนยันว่าไม่มีรหัส OTP ดิบ `842910` อยู่ในไฟล์ Export
  - ปิดเซิร์ฟเวอร์แล้วเปิดใหม่ด้วยไฟล์ SQLite DB เดิม: ยืนยันจำนวนกล่องและข้อความ (`inbox` + `drafts` = 2) ยังอยู่ครบถ้วน
- **Security Scopes, Rate Limit, HMAC & Replay Guard**:
  - เปิด `requireApiKey: true` -> คำขอไม่แนบ Token ได้ `401`
  - Read-only key เรียก `POST /api/v1/inboxes` ได้ `403 INSUFFICIENT_SCOPE`
  - ยิงเกิน Rate Limit (`10/min`) ได้ `429 RATE_LIMITED`
  - `POST /api/v1/inbound` ปฏิเสธ Signature ปลอม (`401`), รับ Signature ถูกต้อง (`201`), และป้องกันการประมวลผลซ้ำเมื่อส่ง `X-Event-Id` เดิม (`200 duplicate: true`)

### 2.5 Frontend Formatting & HTML Sandbox (`src/utils/format.test.ts` — 3 tests)
- `formatRelativeTime`, `formatTtlRemaining` และ `prepareSandboxedEmailHtml` (CSP image toggle, `<base target="_blank">`, ลบ `<script>` และ `target="_self"`)

---

## 3. Live Browser E2E & Visual Verification (`playwright-cli` on `http://localhost:3000`)

### 3.1 User Journeys Verified
1. **Dashboard**: โหลดหน้าแรก, ตรวจสอบ Live Health Badges (`SQLite: พร้อมใช้`, `Mail Provider: Live MX`, `Webhook / SMTP: พร้อมรับ`) และ Recent OTP cards
2. **Create Address + Live DNS MX Check**: ตรวจสอบโดเมนผ่าน `ตรวจสอบ DNS MX`, สร้างกล่อง `e2e-qa@relaybox.dev` ผ่าน UI
3. **Inbound Delivery, Reader & Folders**: รับอีเมล OTP `739104`, เปิดอ่าน HTML Email ใน `<iframe sandbox>`, ทดสอบย้ายไป `ถังขยะ` -> กด `กู้คืนเข้ากล่อง`, และทดลอง Compose บันทึกเป็น `ร่าง`
4. **OTP Center & Addresses Edit**: กรองค้นหาในศูนย์ OTP และเปิด Modal แก้ไข Label/Status/TTL ในหน้าบัญชีของฉัน
5. **API & Webhooks + SMTP Handshake**: ทดสอบกดปุ่มทดสอบเชื่อมต่อ SMTP Handshake ในหน้า UI ได้ผลลัพธ์ `OK (3ms) — 250-relaybox.dev`, ตรวจสอบ Delivery Logs และ API Usage Logs (`200`, `201`)
6. **Activity Log & Redaction**: ตรวจสอบบันทึกกิจกรรมใน UI เห็นข้อความ Redact รหัสเป็น `Masked code: 73****` (ไม่แสดง OTP เต็ม)
7. **Console Cleanliness & Cleanup**: Console ของเบราว์เซอร์รายงาน **`Errors: 0, Warnings: 0`** หลังแก้ไข Bug React duplicate key ใน `handleComposeSubmit` และลบบัญชีทดสอบ `e2e-qa@relaybox.dev` ออกจากระบบเรียบร้อย

### 3.2 Responsive Viewport Verification (Verified via DOM Evaluation)
| Viewport | `scrollWidth` | `innerWidth` | `overflowX` | Result |
| :--- | :---: | :---: | :---: | :--- |
| `1920x1080` (Wide Desktop) | `1920` | `1920` | `false` | **PASS** |
| `1440x900` (Standard Desktop) | `1440` | `1440` | `false` | **PASS** |
| `768x1024` (Tablet) | `768` | `768` | `false` | **PASS** |
| `390x844` (Mobile) | `390` | `390` | `false` | **PASS** (Drawer tested via screenshot) |
| `360x800` (Small Mobile) | `360` | `360` | `false` | **PASS** |

---

## 4. Defects Found & Fixed During Testing

1. **Duplicate React Key in `handleComposeSubmit` (`src/App.tsx`)**: SSE `email:received` กับผลตอบกลับ HTTP `POST /api/v1/messages/send` แทรก `message.id` เดียวกันซ้ำ แก้ไขด้วยการ Deduplicate ตาม `res.message.id` และตรวจซ้ำบนเบราว์เซอร์จนได้ `Errors: 0`
2. **Test Database Isolation (`server/db.ts`, `server/store.ts`, `server.ts`)**: เพิ่ม `legacyJsonPath?: string | null` เพื่อไม่ให้ Integration Test ที่ใช้ DB ชั่วคราวไปนำเข้า `.data/flowmail-store.json` ของ Workspace
3. **`ActivityLogView` `EVENT_LABELS` Type Completeness (`src/components/ActivityLogView.tsx`)**: เพิ่มคำอธิบายภาษาไทยครบทั้ง 19 `ActivityEventType` จน `tsc --noEmit` ผ่านโดยไม่มี Error

---

## 5. Out-of-Scope / Environment-Dependent Items Not Tested Live
- **Outbound External SMTP Relay**: ไม่ได้ส่งอีเมลออกไปยัง Mail Server ภายนอกจริง เนื่องจาก `SMTP_OUTBOUND_HOST` ยังไม่ได้กำหนดค่าใน Sandbox Preview (ต้องกำหนดค่าเมื่อ Deploy บน Production)
