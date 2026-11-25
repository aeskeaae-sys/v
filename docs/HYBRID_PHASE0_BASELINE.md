# Phase 0 — Hybrid Deployment Full Audit Baseline (FlowMail / RelayBox)

**Audit date:** 2026-11-26
**Workspace:** `C:\Users\tee\Downloads\flowmail-api` (existing workspace only; no new project created)
**Baseline taken before any source modification**

## 1. Git / repository baseline

| Item | Result | Evidence |
| :--- | :--- | :--- |
| Git status | **BLOCKED** | `git status --porcelain=v1` -> `fatal: not a git repository (or any of the parent directories): .git` |
| Branch | **BLOCKED** | Same error |
| HEAD | **BLOCKED** | Same error |
| Remote | **BLOCKED** | Same error |
| Commit history | **BLOCKED** | Same error |
| `.git` directory | Absent | `Test-Path -LiteralPath ".git"` -> `False` |
| Write permission | Present | New report written into existing `docs/` directory (this file) |

**Rule 12 note:** write access to the workspace exists; no source file was overwritten before this baseline. Git-based verification remains blocked because workspace has no Git metadata.

## 2. File tree / structure (source-relevant)

- Root: `server.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`, `bun.lock`, `index.html`, `.env.example`, `.gitignore`, `eslint.config.mjs`, `README.md`, `security_spec.md`, `firestore.rules`, `DRAFT_firestore.rules`, `firebase-blueprint.json`, `firebase-applet-config.json`, `metadata.json`.
- Server: `server/{store,db,crypto,parser,mailtm,smtp,dns}.ts` plus tests `server/*.test.ts`.
- Frontend: `src/api/client.ts`, `src/App.tsx`, `src/components/*.tsx`, `src/contexts/FirebaseAuthContext.tsx`, `src/lib/{firebase,firestoreSync,gmailApi}.ts`, `src/utils/{format.ts,format.test.ts}`.
- Shared: `shared/types.ts`.
- CI/docs: `.github/workflows/ci.yml`, `docs/NEXT_PHASE_*.md`, `public/assets/aistudio/*.md`.
- `.aistudio/` contains local temporary screenshots; not application source.
- **Runtime artifacts absent at baseline:** `node_modules` (`False`), `package-lock.json` (`False`), `.env.local` (`False`), `dist` (`False`). `bun.lock` exists (120,327 bytes).

## 3. Package / runtime

- `package.json`: name `react-example`, `type: module`, React 19 + Vite 8 + Express 4 + Firebase 13 + `@google/genai`.
- Scripts: `dev=tsx server.ts`, `start=node server.ts`, `build=vite build`, `preview=vite preview`, `clean=rm -rf dist server.js`, `lint=tsc --noEmit`, `test=tsx --test server/*.test.ts src/utils/*.test.ts`.
- **Important defect:** `start` uses `node server.ts`; Node 22 cannot execute TypeScript source directly without a loader. Must be changed to compiled JS or `tsx server.ts` (production-safe) for Railway/Render.
- Runtime: `node v22.23.5` (built-in `node:sqlite` available), `npm 10.9.9` via `npm.cmd`, `npx 10.9.9` via `npx.cmd`.
- **`npm`/`npx` PowerShell shims blocked** by execution policy (`npm.ps1 cannot be loaded`); use `npm.cmd`/`npx.cmd` explicitly in this environment.
- No `engines` field in `package.json`; no `package-lock.json` (CI falls back to `npm install`).

## 4. Existing CI

`.github/workflows/ci.yml`: checkout -> setup Node 22 -> `npm ci` if lock exists else `npm install` -> `npm run lint` -> `npm test` -> `npm run build`. No deployment job, no security scan, no migration/backup verification.

## 5. Existing deployment configuration

**Absent at baseline:** `Dockerfile`, `vercel.json`, `railway.json`, `render.yaml`, `Procfile`, `.dockerignore`. Express currently serves API + built SPA from one process (`server.ts` lines 1811-1833) and starts a loopback SMTP bridge in the same process (`server.ts:65`, `server/smtp.ts:316`). This is not compatible with Vercel Functions for SMTP; backend must stay on a persistent service.

## 6. Environment variables (`.env.example`)

`GEMINI_API_KEY`, `APP_URL`, `ADMIN_PASSCODE` (optional), `RELAYBOX_ENCRYPTION_KEY` (optional/commented), `REQUIRE_API_KEY` (default false/commented), `WEBHOOK_INBOUND_SECRET`, SMTP inbound/outbound settings, `RETENTION_DAYS`. No `ALLOWED_ORIGINS`, `VITE_API_BASE_URL`, Redis, worker, or production validation variables.

## 7. Documentation already present (not overwritten)

- `docs/NEXT_PHASE_BASELINE_AUDIT.md`: earlier Phase 0 audit from Linux `/app/applet` workspace.
- `docs/NEXT_PHASE_IMPLEMENTATION_REPORT.md`, `NEXT_PHASE_SECURITY_REPORT.md`, `NEXT_PHASE_TEST_REPORT.md`, `NEXT_PHASE_PRODUCTION_READINESS.md`: claim previous 23/23 tests and conditional-go readiness; those results are **not** reused as evidence in this audit — all gates will be re-run locally.
- `README.md` is the AI Studio generic README, not deployment documentation.

## 8. Existing tests (discovered, not yet run)

`server/parser.test.ts`, `server/store.test.ts`, `server/crypto.test.ts`, `server/integration.test.ts`, `src/utils/format.test.ts`, `firestore.rules.test.ts` (not included in `npm test` script). `server/integration.test.ts` starts real Express instances and exercises SQLite persistence, API scopes, HMAC inbound webhook, replay guard, SMTP handshake, admin auth, and activity export.

## 9. Baseline security observations (from source read before edits)

| Observation | Evidence | Severity |
| :--- | :--- | :--- |
| Unauthenticated anonymous context receives `read`, `write`, `webhooks`, `admin` scopes when `REQUIRE_API_KEY=false` | `server.ts:162-166` | Critical |
| `POST /api/v1/session` issues token with full `read/write/webhooks/admin` scopes without any credential check | `server.ts:533-547`, `server.ts:122-127` | Critical |
| Session/admin tokens and rate-limit buckets are process memory only (`Set`/`Map`) | `server.ts:67-69` | High for multi-instance |
| No CORS allowlist or origin validation middleware found | `server.ts` grep: no `cors`/`Origin` handling | High for cross-origin hybrid frontend |
| No production env validation; encryption key/admin passcode/webhook secret/SMTP auth optional | `server/crypto.ts:7-32`, `.env.example` | High |
| SMTP bridge always binds loopback `127.0.0.1:2525` without TLS; AUTH only when env set | `server/smtp.ts:106-116,315-321` | Medium (must not expose externally) |
| Frontend API client hardcodes relative `/api/...` URLs; no `VITE_API_BASE_URL` support | `src/api/client.ts` (all calls) | High for Vercel + separate backend |
| `start` script cannot run TS in production | `package.json:8` | High |
| SQLite DB already has migrations, WAL, encrypted credentials, FK, indexes | `server/db.ts:66-201,224-239`, `server/crypto.ts:34-69` | Positive baseline |

## 10. Phase 0 conclusion

Baseline recorded. No source changes made before this report. Proceeding to Phase 1 with critical auth boundary, centralized authorization, shared session/rate-limit state, CORS/origin controls, and production env validation as first priorities. Git-based diff/remote verification remains an explicit blocker.
