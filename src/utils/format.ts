export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatTtlRemaining(expiresAt: string | null | undefined, now = Date.now()): string {
  if (!expiresAt) return 'Persistent';
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return '—';
  const remaining = t - now;
  if (remaining <= 0) return 'Expired';
  const s = Math.floor(remaining / 1000);
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m left`;
  if (s < 86400) return `${Math.floor(s / 3600)}h left`;
  return `${Math.floor(s / 86400)}d left`;
}

export function prepareSandboxedEmailHtml(html: string, allowImages: boolean): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
  if (!allowImages) {
    out = out.replace(/<img\b[^>]*>/gi, '');
  }
  return out;
}
