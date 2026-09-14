/**
 * Link checker for the ADA / website audit.
 *
 * Every unique link collected during the crawl is fetched once (HEAD, falling
 * back to GET for servers that reject HEAD) and classified. Runs after the
 * crawl so a page is never re-visited just to test its links.
 */
import type { APIRequestContext } from '@playwright/test';
import type { LinkResult, ProgressEvent } from './ada-types.js';

export interface CollectedLink {
  url: string;
  external: boolean;
  referrers: Set<string>;
  text?: string;
}

const SKIP_SCHEMES = /^(mailto:|tel:|sms:|javascript:|data:|ftp:|file:|#)/i;
const CONCURRENCY = 6;
const TIMEOUT_MS = 15_000;

export function shouldCheckLink(href: string): boolean {
  if (!href || SKIP_SCHEMES.test(href.trim())) return false;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function checkLinks(
  request: APIRequestContext,
  links: CollectedLink[],
  opts: { checkExternal: boolean },
  emit: (e: Omit<ProgressEvent, 'seq' | 'at'>) => void,
): Promise<LinkResult[]> {
  const results: LinkResult[] = [];
  const queue = links.filter((l) => opts.checkExternal || !l.external);
  const skipped = links.filter((l) => !opts.checkExternal && l.external);
  for (const l of skipped) {
    results.push({ url: l.url, status: null, ok: true, kind: 'skipped', external: true, referrers: [...l.referrers], linkText: l.text });
  }

  let done = 0;
  let broken = 0;
  const total = queue.length;
  emit({ type: 'links', message: `Checking ${total} unique link${total === 1 ? '' : 's'}${skipped.length ? ` (${skipped.length} external skipped)` : ''}…`, data: { total } });

  // Per-host politeness: never more than 2 in flight to the same host.
  const inFlightByHost = new Map<string, number>();
  const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

  const worker = async () => {
    while (queue.length) {
      // Pick the first link whose host is not saturated.
      let idx = queue.findIndex((l) => (inFlightByHost.get(hostOf(l.url)) || 0) < 2);
      if (idx === -1) { await new Promise((r) => setTimeout(r, 150)); continue; }
      const link = queue.splice(idx, 1)[0];
      const host = hostOf(link.url);
      inFlightByHost.set(host, (inFlightByHost.get(host) || 0) + 1);
      try {
        const r = await checkOne(request, link);
        results.push(r);
        if (r.kind === 'broken' || r.kind === 'server-error' || r.kind === 'timeout' || r.kind === 'error') {
          broken++;
          emit({ type: 'link-check', message: `${r.kind === 'broken' ? 'Broken' : r.kind === 'timeout' ? 'Timed out' : 'Failed'}: ${r.url} (${r.status ?? r.error ?? 'no response'})`, data: { url: r.url, status: r.status, kind: r.kind, referrer: r.referrers[0] } });
        }
      } finally {
        inFlightByHost.set(host, (inFlightByHost.get(host) || 1) - 1);
        done++;
        if (done % 25 === 0 || done === total) {
          emit({ type: 'links', message: `Checked ${done}/${total} links — ${broken} problem${broken === 1 ? '' : 's'} so far`, data: { done, total, broken } });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, total)) }, worker));
  return results;
}

async function checkOne(request: APIRequestContext, link: CollectedLink): Promise<LinkResult> {
  const base: Omit<LinkResult, 'status' | 'ok' | 'kind'> = {
    url: link.url, external: link.external, referrers: [...link.referrers].slice(0, 10), linkText: link.text,
  };
  const attempt = async (method: 'HEAD' | 'GET') => request.fetch(link.url, {
    method,
    timeout: TIMEOUT_MS,
    maxRedirects: 10,
    ignoreHTTPSErrors: true,
    // A plain browser UA for verification - CDNs that reject anything
    // unfamiliar would otherwise report perfectly good links as broken.
    headers: { 'User-Agent': PLAIN_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  try {
    let res = await attempt('HEAD');
    // Many CDNs and app servers answer HEAD with 403/405/404 while GET is fine.
    if (res.status() >= 400) {
      try { await res.dispose(); } catch { /* ignore */ }
      res = await attempt('GET');
    }
    const status = res.status();
    const finalUrl = res.url();
    try { await res.dispose(); } catch { /* ignore */ }
    const redirected = normalise(finalUrl) !== normalise(link.url);
    if (status >= 200 && status < 300) return { ...base, status, ok: true, kind: redirected ? 'redirect' : 'ok', finalUrl: redirected ? finalUrl : undefined };
    if (status >= 300 && status < 400) return { ...base, status, ok: true, kind: 'redirect', finalUrl };
    if (status >= 500) return { ...base, status, ok: false, kind: 'server-error', finalUrl };
    // 401/403/429 (and the odd 400) almost always mean "no bots", not "no page".
    // Report them as unverifiable rather than broken so the count stays honest.
    if ([400, 401, 403, 405, 406, 429, 451].includes(status)) return { ...base, status, ok: true, kind: 'blocked', finalUrl };
    return { ...base, status, ok: false, kind: 'broken', finalUrl };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    const timeout = /timeout|timed out/i.test(msg);
    return { ...base, status: null, ok: false, kind: timeout ? 'timeout' : 'error', error: msg.split('\n')[0].slice(0, 200) };
  }
}

function normalise(u: string): string {
  try { const x = new URL(u); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return u; }
}

export const PLAIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const BROWSER_UA = `${PLAIN_UA} IntelliQE-Audit/1.0`;
