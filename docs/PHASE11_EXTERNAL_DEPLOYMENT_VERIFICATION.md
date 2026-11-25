# Phase 11 External Deployment Verification Report

Workspace: `C:\Users\tee\Downloads\flowmail-api`
Verification window: `2026-11-26T01:24:02.9702502+07:00` to `2026-11-26T01:33:57.6431385+07:00`
Method: independent re-reading and re-running; no prior report was assumed correct.
Deployed URLs: **NONE** (no Railway/Render/Vercel deployment was performed).

## Final Decision

**CONDITIONAL GO for local/source readiness. NO-GO for production release until external deployment evidence exists.**

- All local code, security, migration, backup/restore, worker, lint, test, and build gates pass.
- GO cannot be claimed: `docker`, `railway`, `render`, and `vercel` are unavailable; no platform credentials, no project URL, and no Git remote exist.
- Production release is blocked on real external deployment verification with URLs and smoke results.

## 11.1 Source Integrity

| Check | Status | Timestamp (+07:00) | Evidence / failure output |
|---|---:|---|---|
| Read `docs/HYBRID_VERIFICATION_REPORT.md` | PASS | 01:24:02 | Read independently; prior `42 tests` claim later superseded by verified `43 tests`. |
| Read `docs/HYBRID_DEPLOYMENT.md` | PASS | 01:24:02 | Read independently; confirmed selected backend is SQLite + persistent volume, not PostgreSQL. |
| Expected source file inventory | PASS | 01:24:43.4769367 | 27/27 expected files present; `all_expected_files_present=true`. |
| `.env` / `.env.local` / `.data` on disk | PASS | 01:24:40 | All absent. |
| `.gitignore` exclusions | PASS | 01:24:40 | `node_modules/`, `build/`, `dist/`, `coverage/`, `*.log`, `.env*`, `!.env.example`, `.data/`, `.playwright-cli/`. |
| Git tracked secret files | PASS | 01:24:44.6522159 | `git ls-files` env/data/node_modules/dist filter returned only `.env.example`; `tracked_count=124`. |
| Staged source secret-pattern scan | PASS with note | 01:31:51.5928662 | `secret_pattern_files=firebase-applet-config.json`. Hit is a public Firebase web client config used by `src/lib/firebase.ts`, not a backend secret; left unchanged. No GitHub token, service-role key, private key, or backend API secret found. |
| Git state | PASS with note | 01:30:17.3603388 | `git init -q` + `git add -A` created; `staged_or_modified_entries=124`, `untracked_or_unstaged_count=0`. No commit and no HEAD: `fatal: your current branch 'master' does not have any commits yet` (`git_log_exit=128`). No baseline diff possible. |
| No ZIP/package artifacts created | PASS | 01:33 | No ZIP created; workspace source used directly. |
| `package.json` / lockfile consistency | PASS | 01:33:48.2630448 | `npm ci --dry-run`: `added 85 packages in 9s`, `npm_ci_dry_run_exit=0`. Lockfile top-level deps match `package.json`; `tsx` runtime dependency and `esbuild ^0.28.2` dev dependency present. |
| Node/npm runtime | PASS | 01:24 | `node v22.23.5`; `npm.cmd` path used because `npm.ps1` is blocked by PowerShell policy. |

## 11.2 Docker / Runtime

| Check | Status | Timestamp (+07:00) | Evidence / failure output |
|---|---:|---|---|
| Docker required by selected deployment config | PASS | 01:24 | `Dockerfile` and `docker-compose.yml` exist and are the documented backend path; Vercel config is SPA-only. |
| Docker CLI available | BLOCKED | 01:33:05.7172557 | `docker FAILURE: The term 'docker' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.` |
| Dockerfile build/test | BLOCKED | 01:33:05.7172557 | Not run; no Docker daemon/CLI. No fabricated container result. |
| `docker compose` runtime smoke | BLOCKED | 01:33:05.7172557 | Not run; no Docker daemon/CLI. |
| Local Node runtime start | PASS | 01:31:03.4097066 | `RelayBox Enterprise server listening on http://0.0.0.0:3110`. |
| Local worker runtime start | PASS | 01:31:03.4097066 | `[worker] worker-3704-452ffb4d started; migrations=3`. |

## 11.3 Backend Deployment Verification

| Requirement | Status | Timestamp (+07:00) | Evidence / failure output |
|---|---:|---|---|
| Railway CLI/token | BLOCKED | 01:33:05.7172557 | `railway FAILURE: The term 'railway' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.` No `RAILWAY_TOKEN`. |
| Render CLI/token | BLOCKED | 01:33:05.7172557 | `render FAILURE: The term 'render' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.` No `RENDER_TOKEN`. |
| Git remote for deploy | BLOCKED | 01:33:05.7172557 | `git remote -v` output empty. `gh` is installed and logged in as `aeskeaae-sys`, but no repository remote/project target exists. |
| Backend deployed URL | NONE | 01:33 | No URL supplied or discovered. |
| External `/api/health` | BLOCKED | 01:33 | Not verified externally. Local equivalent PASS below. |
| External DB persistence | BLOCKED | 01:33 | No persistent volume on a deployed backend. Local equivalent PASS below. |
| Encryption key persistence | BLOCKED | 01:33 | No deployed secret store verified. Local equivalent: key-file persistence covered by test #2. |
| External worker startup/background job | BLOCKED | 01:33 | No deployed worker. Local equivalent PASS below. |
| External backup/restore | BLOCKED | 01:33 | No deployed DB. Local equivalent PASS below. |
| External restart recovery | BLOCKED | 01:33 | No deployed restart performed. Local worker restart probe exercised DB-backed heartbeat/job state. |

### Local backend equivalents that PASS

| Check | Status | Timestamp (+07:00) | Evidence / failure output |
|---|---:|---|---|
| Production-mode API health | PASS | 01:31:03.4097066 | `GET http://127.0.0.1:3110/api/health -> 200`. |
| Production-mode worker health | PASS | 01:31:03.4097066 | `GET http://127.0.0.1:3110/api/health/worker -> 200` with worker running. Earlier workerless run: `503`, expected. |
| Worker heartbeat + job execution | PASS | 01:26:20.8169067 | `{"jobs":[{"id":"phase11-maintenance","status":"succeeded","attempts":0}],"heartbeats":[{"name":"worker-11036-bba6b26c","lastSeen":"2026-11-25T18:26:38.824Z","jobsProcessed":1}]}`. |
| Migration check | PASS | 01:25:45.0731740 | `migrate_check_exit=0`, `version: 3`, `count: 3`, `integrity: ok`, `job_queue: 1`. |
| Backup | PASS | 01:25:45.0731740 | `backup_exit=0`, `integrity: ok`, `bytes: 200704`. |
| Restore to explicit target | PASS | 01:26:20.8169067 | `restore_to_explicit_target_exit=0`, `restored_check_exit=0`, restored DB `integrity: ok`, `job_queue: 1`. |
| Restore harness mistake | FAIL then corrected | 01:25:45.0731740 | First restore attempt targeted the live DB path due env override: `restore_check_exit=1`. Corrected by explicit target `FLOWMAIL_DB_PATH=$tmp\restored.db`; no application defect. |
| Encryption persistence | PASS | 01:31:18.5665918 | Test #2: `SecretCipher encrypts, persists key file, decrypts, and rejects tampered ciphertext`. |
| Production env validation negative | PASS | 01:25:45.0731740 | `NODE_ENV=production` without secrets exited `1` with errors for `RELAYBOX_ENCRYPTION_KEY`, `ADMIN_PASSCODE`, `WEBHOOK_INBOUND_SECRET`, `REQUIRE_API_KEY`. |

## 11.4 Vercel / Frontend Deployment Verification

| Requirement | Status | Timestamp (+07:00) | Evidence / failure output |
|---|---:|---|---|
| Vercel CLI/token | BLOCKED | 01:33:05.7172557 | `vercel FAILURE: The term 'vercel' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.` No `VERCEL_TOKEN`. |
| Frontend deployed URL | NONE | 01:33 | No URL supplied or discovered. |
| Vercel build | BLOCKED | 01:33 | Not verified on Vercel. Local build PASS below. |
| SPA routing on Vercel | BLOCKED | 01:33 | `vercel.json` exists; not externally exercised. Local production SPA route PASS below after fix. |
| API base URL on deployed SPA | BLOCKED | 01:33 | `src/api/client.ts` uses `VITE_API_BASE_URL`, but no deployed value verified. |
| HTTPS/CORS/auth/dashboard/inbox/OTP external smoke | BLOCKED | 01:33 | Not verified externally. Local equivalents below. |

### Local frontend/production-mode equivalents that PASS

| Check | Status | Timestamp (+07:00) | Evidence / failure output |
|---|---:|---|---|
| Vite production build | PASS | 01:31:18.5665918 to 01:31:41.9053206 | `✓ 1699 modules transformed.`, `✓ built in 2.92s`, `build_exit=0`; only chunk > 500 kB warning. |
| SPA fallback (initial failure) | FAIL then fixed | 01:30:39.0065032 | `GET http://127.0.0.1:3109/some-spa-route -> 404`; caused by Express pattern `/{*splat}`. |
| SPA fallback after fix | PASS | 01:31:03.4097066 | `GET http://127.0.0.1:3110/some-spa-route -> 200` after changing `server.ts` to `app.get('*', ...)` with `/api/*` guard. |
| Unknown API path guard | PASS | 01:31:03.4097066 | SPA fallback no longer swallows `/api/*`; unknown API paths return JSON 404 by code path. |
| CORS allowed/preflight | PASS | 01:31:03.4097066 | `OPTIONS /api/v1/inboxes` with `Origin: http://localhost:5173 -> 204`. |
| CORS blocked/preflight | PASS | 01:31:03.4097066 | `OPTIONS /api/v1/inboxes` with `Origin: https://evil.example -> 403`. |
| Anonymous auth bootstrap | PASS | 01:31:03.4097066 | `POST /api/v1/session -> 200 scopes=read`. |
| Anonymous write rejection | PASS | 01:31:03.4097066 | `POST /api/v1/inboxes` with anonymous token -> `403`. |
| Protected API without auth | PASS | 01:31:03.4097066 | `GET /api/v1/inboxes -> 401`. |

## 11.5 Production Security Verification

| Requirement | Status | Timestamp (+07:00) | Evidence / test numbers |
|---|---:|---|---|
| Anonymous access | PASS | 01:31:18.5665918 | Tests #21, #23; local smoke `401`/`403`/`read`. |
| Admin auth | PASS | 01:31:18.5665918 | Tests #8, #35; DB-backed admin session and separated `/api/admin`. |
| Session expiration | PASS | 01:27:56.3218352 and 01:31:18.5665918 | New test #23: `security: expired sessions are rejected -> 401`. |
| Session revocation/logout | PASS | 01:31:18.5665918 | Test #22. |
| API key scopes | PASS | 01:31:18.5665918 | Tests #6, #31; `requireScope()` in `server/auth.ts:151`. |
| Rate limits | PASS | 01:31:18.5665918 | Tests #6, #25; `consumeRateLimit()` in `server/db.ts:481`. |
| CSRF / state-changing origin guard | PASS | 01:31:18.5665918 | Tests #24; `createOriginGuard()` in `server/auth.ts:246`; local evil-origin `403`. |
| CORS | PASS | 01:31:18.5665918 | Tests #24; `createCorsMiddleware()` in `server/auth.ts:219`; local `204`/`403`. |
| SSRF | PASS | 01:31:18.5665918 | Tests #7, #17, #18; `validateOutboundWebhookTarget()` in `server/parser.ts:350`; `redirect: 'manual'` in `server.ts:117` and `worker.ts:53`. |
| Secret exposure | PASS with note | 01:31:51.5928662 | No backend secrets in tracked source; Firebase public client config noted above. |
| Env validation | PASS | 01:25:45.0731740 | Dev `check:env` `0`; production missing secrets `1`. |
| CSP/HSTS | PASS | 01:31:18.5665918 | Set in `server.ts:329` and `server.ts:332`; covered by build/static smoke code path. |

## Verified Test Run: Every Test

Command: `& "C:\Program Files\nodejs\npm.cmd" test`
Window: `2026-11-26T01:31:18.5665918+07:00` to `2026-11-26T01:31:41.9053206+07:00`
Summary: `1..43`, `# tests 43`, `# suites 0`, `# pass 43`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`, `# duration_ms 8604.8522`, `test_exit=0`.

| # | Test | Result | Duration (ms) |
|---:|---|---|---:|
| 1 | SQLite backup, migration check, and restore preserve row counts and integrity | PASS | 144.1436 |
| 2 | SecretCipher encrypts, persists key file, decrypts, and rejects tampered ciphertext | PASS | 41.5813 |
| 3 | HMAC webhook signature signs, verifies, and rejects forged or expired payloads | PASS | 1.7914 |
| 4 | redacts OTP codes and sensitive webhook URLs safely for audit logs | PASS | 1.782 |
| 5 | integration: full API lifecycle, folders, OTP, SMTP bridge, activity export, and persistence | PASS | 1695.3205 |
| 6 | integration: API key scopes, rate limits, HMAC inbound verification, and replay deduplication | PASS | 305.5991 |
| 7 | integration: webhook registry CRUD, SSRF block, event filter update, and test endpoint | PASS | 113.5161 |
| 8 | integration: Gmail & Outlook alias creation, message import, and separated /api/admin auth & management | PASS | 836.9351 |
| 9 | integration: POST /api/v1/messages/bulk performs bulk read, star, trash, and permanent delete | PASS | 249.41 |
| 10 | integration: POST /api/v1/inboxes with deliverCredentialsEmail sends password email into new inbox | PASS | 96.0366 |
| 11 | normalizeEmailAddress handles plain and display-name formats | PASS | 9.0289 |
| 12 | extractOtpCodes extracts contextual and standalone verification codes while ignoring years | PASS | 11.1565 |
| 13 | extractLinks filters unsafe protocols and classifies verification and reset links | PASS | 6.0985 |
| 14 | extractArtifacts selects primaryOtp and primaryActionUrl | PASS | 1.5525 |
| 15 | stripHtmlToText removes scripts, styles, and decodes entities | PASS | 0.659 |
| 16 | sanitizeEmailHtmlForSandbox strips scripts, svg, form, srcdoc, inline handlers, and adds strict CSP | PASS | 4.7979 |
| 17 | validateOutboundWebhookUrl blocks private/loopback hosts and allows public https | PASS | 2.1534 |
| 18 | validateOutboundWebhookTarget rejects DNS rebinding to private addresses | PASS | 22.5469 |
| 19 | MIME multipart parser decodes quoted-printable/base64 and sanitizes attachments | PASS | 16.6383 |
| 20 | spam classifier flags phishing + executable payloads and threadId groups replies | PASS | 4.096 |
| 21 | security: anonymous session bootstrap is read-only and rejects write/admin routes | PASS | 1389.5145 |
| 22 | security: invalid session credentials are rejected and logout revokes tokens | PASS | 131.894 |
| 23 | security: expired sessions are rejected | PASS | 63.5087 |
| 24 | security: CORS allowlist and state-changing origin guard are enforced | PASS | 88.5694 |
| 25 | security: sessions and rate-limit counters are shared across instances on one database | PASS | 237.415 |
| 26 | security: production environment validation blocks default secrets | PASS | 2.0916 |
| 27 | creates webhook inboxes, prevents duplicates, and keeps private credentials out of public views | PASS | 59.558 |
| 28 | ingests messages, deduplicates by remoteId, updates read/starred state, and extracts OTPs | PASS | 98.1493 |
| 29 | autoCreateInbox provisions webhook inbox on first incoming message when enabled | PASS | 11.1403 |
| 30 | waitForMessage resolves when matching message arrives | PASS | 90.1765 |
| 31 | API keys are hashed on store and verified via timingSafeEqual | PASS | 17.3896 |
| 32 | supports folders (inbox, sent, drafts, spam, trash), internal delivery, and restore/permanent delete | PASS | 56.0923 |
| 33 | surfaces Mail.tm 429 rate limits and applies store sync cooldown without marking inbox broken | PASS | 172.6307 |
| 34 | creates Gmail and Outlook aliases, prevents invalid domain mismatches, and marks synced | PASS | 23.5219 |
| 35 | handles atomic first-run admin passcode setup, scrypt verification, update, and overview stats | PASS | 1952.9721 |
| 36 | bulkActionMessages marks read/unread, stars/unstars, moves to trash, restores, and permanently deletes | PASS | 74.1883 |
| 37 | deliverCredentialsEmail delivers per-inbox password email for Webhook, Alias, and Live MX inboxes | PASS | 185.1455 |
| 38 | job queue claims work once, completes it, and recovers stale leases | PASS | 49.9233 |
| 39 | job queue applies exponential backoff then marks dead-letter jobs | PASS | 36.4818 |
| 40 | worker heartbeats are persisted and migrations include the queue schema | PASS | 31.106 |
| 41 | formatRelativeTime formats seconds, minutes, hours, and days | PASS | 22.1792 |
| 42 | formatTtlRemaining formats persistent, active, and expired states | PASS | 0.8436 |
| 43 | prepareSandboxedEmailHtml blocks scripts and toggles image CSP | PASS | 7.48 |

### Earlier failures during this verification

| Failure | Timestamp (+07:00) | Output | Resolution |
|---|---|---|---|
| Flaky stale-lease test | 01:27:56.3218352 | `server/worker-queue.test.ts:57`, `assert.equal(db.recoverStaleJobs(0), 1)` | Changed `recoverStaleJobs()` in `server/db.ts` from `locked_at < ?` to `locked_at <= ?`; final suite passed twice and once more after `server.ts` fix. |
| Restore harness targeted live DB | 01:25:45.0731740 | `restore_check_exit=1` | Harness env issue only; explicit target restore passed. |
| SPA fallback 404 | 01:30:39.0065032 | `GET /some-spa-route -> 404` | Changed `server.ts` wildcard from `/{*splat}` to `'*'` with `/api/*` guard; retest `200`. |
| Workerless worker health | 01:30:39.0065032 | `GET /api/health/worker -> 503` | Expected; with worker running it became `200`. |

## Commands Run

| Command | Timestamp (+07:00) | Result |
|---|---|---|
| `& "C:\Program Files\nodejs\npm.cmd" run lint` | 01:31:18.5665918 | `lint_exit=0` |
| `& "C:\Program Files\nodejs\npm.cmd" test` | 01:31:18.5665918 | `test_exit=0`, 43/43 |
| `& "C:\Program Files\nodejs\npm.cmd" run build` | 01:31:18.5665918 | `build_exit=0` |
| `& "C:\Program Files\nodejs\npm.cmd" ci --dry-run` | 01:33:48.2630448 | `npm_ci_dry_run_exit=0` |
| `& "C:\Program Files\nodejs\npm.cmd" run check:env` (dev) | 01:25:45.0731740 | `check_env_dev_exit=0` |
| `NODE_ENV=production` + missing secrets `npm run check:env` | 01:25:45.0731740 | exit `1`, 4 expected errors |
| `npm run migrate:check` | 01:25:45.0731740 | `migrate_check_exit=0` |
| `npm run backup -- <temp>\backup.db` | 01:25:45.0731740 | `backup_exit=0`, bytes `200704` |
| explicit-target restore + verify | 01:26:20.8169067 | `restore_to_explicit_target_exit=0`, `restored_check_exit=0` |
| worker start + DB job/heartbeat probe | 01:26:20.8169067 | job `phase11-maintenance` `succeeded`; worker heartbeat persisted |
| production-mode API + worker local smoke | 01:31:03.4097066 | health `200`, worker health `200`, SPA `200`, auth `401`/`403`, CORS `204`/`403` |

## Required Next Actions Before GO

1. Install Docker or use a machine with Docker; build and run `Dockerfile`/`docker-compose.yml`; record build logs and container health.
2. Deploy backend to Railway or Render with persistent volume and secrets; provide real URL and smoke results for health, worker, DB persistence, encryption-key persistence, backup/restore, and restart recovery.
3. Deploy frontend to Vercel with `VITE_API_BASE_URL`; provide real URL and smoke results for build, SPA routing, HTTPS, CORS, login/admin setup, dashboard, inbox, and OTP extraction.
4. Re-run the Phase 11 checklist against those URLs. Only then change the decision to GO.

No production deployment success is claimed in this report.
