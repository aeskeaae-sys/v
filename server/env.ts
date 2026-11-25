export interface ProductionEnvReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateProductionEnv(env: NodeJS.ProcessEnv = process.env): ProductionEnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (env.NODE_ENV !== 'production') {
    return { ok: true, errors, warnings };
  }

  if ((env.RELAYBOX_ENCRYPTION_KEY || '').trim().length < 32) {
    errors.push('RELAYBOX_ENCRYPTION_KEY must be at least 32 characters in production.');
  }
  if ((env.ADMIN_PASSCODE || '').trim().length < 12) {
    errors.push('ADMIN_PASSCODE must be at least 12 characters in production.');
  }
  if ((env.WEBHOOK_INBOUND_SECRET || '').trim().length < 16) {
    errors.push('WEBHOOK_INBOUND_SECRET must be at least 16 characters in production.');
  }
  if (env.REQUIRE_API_KEY !== 'true') {
    errors.push('REQUIRE_API_KEY must be "true" in production.');
  }
  if (env.SMTP_ENABLED === 'true') {
    if (!(env.SMTP_AUTH_USER || '').trim() || !(env.SMTP_AUTH_PASS || '').trim()) {
      errors.push('SMTP_AUTH_USER and SMTP_AUTH_PASS are required when SMTP_ENABLED=true.');
    }
    if (env.SMTP_BIND !== '127.0.0.1') {
      errors.push('SMTP_BIND must remain 127.0.0.1; terminate TLS with an external MTA.');
    }
  }
  if (!(env.ALLOWED_ORIGINS || '').trim()) {
    warnings.push('ALLOWED_ORIGINS is empty; only same-origin browser requests will be accepted.');
  }
  if (!(env.VITE_API_BASE_URL || '').trim()) {
    warnings.push('VITE_API_BASE_URL is not set; frontend must be served from the API origin.');
  }

  return { ok: errors.length === 0, errors, warnings };
}
