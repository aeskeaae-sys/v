import dns from 'node:dns/promises';

export interface MxLookupResult {
  domain: string;
  mxVerified: boolean;
  records: { exchange: string; priority: number }[];
  error?: string;
  checkedAt: string;
}

const mxCache = new Map<string, { result: MxLookupResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function checkDomainMxRecords(
  rawDomain: string,
  forceRefresh = false,
): Promise<MxLookupResult> {
  const domain = rawDomain.trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return {
      domain,
      mxVerified: false,
      records: [],
      error: 'Invalid domain format.',
      checkedAt: new Date().toISOString(),
    };
  }

  const now = Date.now();
  const cached = mxCache.get(domain);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DNS MX lookup timed out')), 4000),
      ),
    ]);
    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    const result: MxLookupResult = {
      domain,
      mxVerified: sorted.length > 0,
      records: sorted,
      checkedAt: new Date().toISOString(),
    };
    mxCache.set(domain, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  } catch (err) {
    const result: MxLookupResult = {
      domain,
      mxVerified: false,
      records: [],
      error: err instanceof Error ? err.message : 'No MX records found.',
      checkedAt: new Date().toISOString(),
    };
    mxCache.set(domain, { result, expiresAt: now + 60_000 });
    return result;
  }
}
