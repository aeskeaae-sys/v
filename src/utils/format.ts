export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function formatExactTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatTtlRemaining(expiresAt: string | null, nowMs = Date.now()): string {
  if (!expiresAt) return 'Persistent';
  const expMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expMs)) return 'Persistent';
  const remainingMs = expMs - nowMs;
  if (remainingMs <= 0) return 'Expired';
  const mins = Math.ceil(remainingMs / 60000);
  if (mins < 60) return `${mins}m TTL`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h TTL`;
  const days = Math.round(hrs / 24);
  return `${days}d TTL`;
}

export function prepareSandboxedEmailHtml(html: string, allowRemoteImages: boolean): string {
  const stripped = (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<applet[\s\S]*?<\/applet>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<math[\s\S]*?<\/math>/gi, '')
    .replace(/<(?:frame|frameset|form|input|textarea|select|button)\b[^>]*>/gi, '')
    .replace(/<\/(?:frame|frameset|form|textarea|select|button)>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*(?:refresh|content-security-policy)[^>]*>/gi, '')
    .replace(/\s(?:on[a-z]+|srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /(href|src|action|poster)\s*=\s*(?:"\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|[^\s>]*javascript:[^\s>]*)/gi,
      '$1="#"',
    )
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/@import\b/gi, '@blocked')
    .replace(/(<a\b[^>]*?)\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');

  const imgDirective = allowRemoteImages ? 'https: http: data:' : 'data:';
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgDirective}; font-src 'none'; script-src 'none'; object-src 'none'; connect-src 'none'; form-action 'none';">`;
  const baseTag = `<base target="_blank">`;
  const baseCss = `<style>html,body{margin:0;padding:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;background:#ffffff;word-break:break-word;}img{max-width:100%;height:auto;}a{color:#2563eb;cursor:pointer;}</style>`;
  const headInject = `${cspMeta}${baseTag}${baseCss}`;

  if (/<html[\s>]/i.test(stripped)) {
    if (/<head[\s>]/i.test(stripped)) {
      return stripped.replace(/<head([^>]*)>/i, `<head$1>${headInject}`);
    }
    return stripped.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${headInject}</head>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">${headInject}</head><body>${stripped}</body></html>`;
}
