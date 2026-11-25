# RelayBox Enterprise — Temporary Mailbox Platform

Full-stack temporary email platform with Live MX (Mail.tm), Webhook, and SMTP inbound providers, SQLite persistence, AES-256-GCM secret encryption, API scopes, rate limiting, and real-time SSE.

## Prerequisites

- Node.js 22+ (recommended) or 20+
- npm 10+

## Quick Start

```bash
npm install --legacy-peer-deps
cp .env.example .env
# Set RELAYBOX_ENCRYPTION_KEY (32+ chars)
npm run dev
```

Production:

```bash
npm run build
NODE_ENV=production npm start
```

## Environment

See `.env.example`. Do not commit real secrets.

| Variable | Description |
|----------|-------------|
| RELAYBOX_ENCRYPTION_KEY | AES-256-GCM key |
| REQUIRE_API_KEY | Enforce API auth |
| RELAYBOX_BOOTSTRAP_SECRET | Session bootstrap when API key required |
| PORT | HTTP port (default 3000) |
| SMTP_PORT | ESMTP port (default 2525) |
| RETENTION_DAYS | Message retention (default 30) |

## Scripts

- `npm run dev` / `npm start` — server via tsx
- `npm run build` — Vite production build
- `npm run lint` — TypeScript check
- `npm test` — unit tests

## Security

Anonymous callers get read-only when REQUIRE_API_KEY is false. Sessions expire. Outbound webhooks are SSRF-validated. Secrets encrypted at rest.
