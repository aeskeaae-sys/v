import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ApiKeyScope, ApiKeySummary } from '../shared/types.ts';
import type { FlowMailStore } from './store.ts';

export type AuthType = 'api-key' | 'session' | 'anonymous';

export interface AuthContext {
  authType: AuthType;
  scopes: Set<ApiKeyScope>;
  key?: ApiKeySummary;
  sessionId?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      rawBody?: string;
    }
  }
}

export type SessionKind = 'ui' | 'elevated' | 'admin';

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function issueAuthSession(
  store: FlowMailStore,
  input: { kind: SessionKind; scopes: ApiKeyScope[]; ttlMs?: number },
): Promise<{ token: string; expiresAt: string }> {
  const token = `fm_${input.kind === 'admin' ? 'adm' : 'ses'}_${crypto.randomBytes(24).toString('hex')}`;
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + (input.ttlMs ?? 12 * 60 * 60 * 1000));
  await store.database.insertSession({
    tokenHash: hashSessionToken(token),
    kind: input.kind,
    scopes: Array.from(new Set(input.scopes)),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function revokeAuthSession(store: FlowMailStore, token: string): Promise<boolean> {
  return await store.database.revokeSession(hashSessionToken(token));
}

export function extractBearerOrApiKey(req: Request): string | null {
  const xApiKey = req.header('x-api-key');
  if (xApiKey && xApiKey.trim()) return xApiKey.trim();

  const auth = req.header('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  if (req.path === '/events' && typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return null;
}

export function createApiAuthMiddleware(
  store: FlowMailStore,
  getRequireApiKey: () => boolean,
): (req: Request, res: Response, next: NextFunction) => void {
  const handle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearerOrApiKey(req);
    let authCtx: AuthContext;

    if (token) {
      const session = await store.database.getSession(hashSessionToken(token));
      if (session) {
        authCtx = {
          authType: 'session',
          scopes: new Set<ApiKeyScope>(session.scopes as ApiKeyScope[]),
          sessionId: session.tokenHash,
        };
      } else {
        const verifiedKey = await store.verifyApiKey(token);
        if (!verifiedKey) {
          await store.recordActivity(
            'auth:failed',
            `Rejected invalid API credential on ${req.method} ${req.originalUrl}`,
            undefined,
            undefined,
            'error',
          );
          res.status(401).json({
            error: 'Invalid API key or session token.',
            code: 'UNAUTHORIZED',
          });
          return;
        }
        authCtx = {
          authType: 'api-key',
          scopes: new Set<ApiKeyScope>(verifiedKey.scopes),
          key: verifiedKey,
        };
      }
    } else if (getRequireApiKey()) {
      await store.recordActivity(
        'auth:failed',
        `Blocked unauthenticated request to ${req.method} ${req.originalUrl}`,
        undefined,
        undefined,
        'warning',
      );
      res.status(401).json({
        error: 'API key required. Pass Authorization: Bearer <key> or x-api-key: <key>.',
        code: 'API_KEY_REQUIRED',
      });
      return;
    } else {
      authCtx = {
        authType: 'anonymous',
        scopes: new Set<ApiKeyScope>(['read']),
      };
    }

    req.auth = authCtx;

    if (req.path === '/events') {
      next();
      return;
    }

    const limit = authCtx.key?.rateLimitPerMin ?? (authCtx.authType === 'anonymous' ? 60 : 240);
    const bucketId =
      authCtx.key?.id ??
      (authCtx.sessionId ? `session:${authCtx.sessionId.slice(0, 12)}` : `ip:${req.ip || 'local'}`);
    const rl = await store.database.consumeRateLimit(`rl:${bucketId}`, limit);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.resetSec));
      res.status(429).json({
        error: 'Rate limit exceeded. Retry later.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: rl.resetSec,
      });
      return;
    }
    next();
  };
  return (req, res, next) => {
    void handle(req, res, next).catch(next);
  };
}

export function requireScope(scope: ApiKeyScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth?.scopes.has(scope) && !req.auth?.scopes.has('admin')) {
      res.status(403).json({
        error: `Credential lacks required "${scope}" scope.`,
        code: 'INSUFFICIENT_SCOPE',
      });
      return;
    }
    next();
  };
}

export function createAdminAuthMiddleware(store: FlowMailStore) {
  const handle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.header('authorization');
    const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const session = token ? await store.database.getSession(hashSessionToken(token)) : null;
    if (!token || !session || session.kind !== 'admin') {
      res.status(401).json({
        error: 'ต้องเข้าสู่ระบบผู้ดูแลระบบหลังบ้าน (Admin) ก่อนดำเนินการ',
        code: 'ADMIN_UNAUTHORIZED',
      });
      return;
    }
    req.auth = {
      authType: 'session',
      scopes: new Set<ApiKeyScope>(session.scopes as ApiKeyScope[]),
      sessionId: session.tokenHash,
    };
    next();
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    void handle(req, res, next).catch(next);
  };
}

export function extractAdminToken(req: Request): string | null {
  const auth = req.header('authorization');
  return auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
}

export async function isAdminTokenValid(
  store: FlowMailStore,
  token: string | null,
): Promise<boolean> {
  if (!token) return false;
  const session = await store.database.getSession(hashSessionToken(token));
  return session?.kind === 'admin';
}

function parseAllowedOrigins(): Set<string> {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (configured.length > 0) return new Set(configured);
  if (process.env.NODE_ENV === 'production') return new Set();
  return new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
}

function isSameOrigin(req: Request, origin: string): boolean {
  const host = req.header('host');
  if (!host) return false;
  const forwarded = req.header('x-forwarded-proto');
  const proto = (forwarded || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  return origin === `${proto}://${host}`;
}

export function createCorsMiddleware() {
  const allowed = parseAllowedOrigins();
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    const permitted = Boolean(origin && (allowed.has(origin) || isSameOrigin(req, origin)));
    if (permitted && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'false');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-API-Key, X-Event-Id, Idempotency-Key, X-RelayBox-Signature',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After',
      );
    }
    if (req.method === 'OPTIONS') {
      res.status(permitted ? 204 : 403).end();
      return;
    }
    next();
  };
}

export function createOriginGuard() {
  const allowed = parseAllowedOrigins();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const origin = req.header('origin');
    if (origin && !allowed.has(origin) && !isSameOrigin(req, origin)) {
      res.status(403).json({ error: 'Origin not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
      return;
    }
    next();
  };
}
