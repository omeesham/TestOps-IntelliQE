/**
 * ssrf-guard.ts — egress controls for server-side fetches of user/tenant-supplied
 * URLs (the product's core job: load test, security scan, flow steps, monitors,
 * webhooks, OIDC issuers, import-from-URL …).
 *
 * The attack: a tenant points IntelliQE at `http://169.254.169.254/…` (cloud
 * metadata → credential theft) or `http://10.x`/`localhost` (internal network
 * scan / pivot). Nothing stopped that before this module.
 *
 * Two layers:
 *   1. `assertUrlAllowed(url)` — a pre-flight that validates the scheme and
 *      DNS-resolves the host, rejecting private/metadata/reserved targets. Use at
 *      direct `fetch()` call sites.
 *   2. `getSsrfDispatcher()` — an undici Agent whose `connect.lookup` re-validates
 *      the resolved IP at SOCKET-CONNECT time, so it also blocks redirect targets
 *      and DNS-rebinding (resolve-public-then-swap-to-private). Use as the default
 *      dispatcher for the shared HTTP helpers, and compose into the mTLS agent.
 *
 * Policy (safe-by-default for hosted SaaS, non-breaking for dev / self-hosted):
 *   - Cloud-metadata + reserved/multicast/unspecified ranges are ALWAYS blocked.
 *   - loopback / link-local / private ranges are blocked UNLESS private access is
 *     allowed (default: allowed in non-production so local dev + the localhost
 *     test-kit keep working; blocked in production). Override with
 *     `SSRF_ALLOW_PRIVATE=true|false`.
 *   - `SSRF_ALLOWED_HOSTS` is an exact-hostname allowlist that bypasses the block
 *     (for a self-hosted install that intentionally targets a known internal host).
 */
import dns from 'node:dns';
import net from 'node:net';

export type IpCategory =
  | 'public' | 'metadata' | 'loopback' | 'linklocal' | 'private'
  | 'multicast' | 'reserved' | 'unspecified';

// ── config ────────────────────────────────────────────────────────────────
function envAllowPrivate(): boolean {
  const v = (process.env.SSRF_ALLOW_PRIVATE || '').trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  // Default: dev/test allow internal targets, production blocks them.
  return process.env.NODE_ENV !== 'production';
}
function allowedHosts(): Set<string> {
  return new Set(
    (process.env.SSRF_ALLOWED_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}
function normalizeHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

// ── IP parsing (BigInt, v4 + v6) ────────────────────────────────────────────
function v4ToBig(ip: string): bigint | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let v = 0n;
  for (let i = 1; i <= 4; i++) { const o = Number(m[i]); if (o > 255) return null; v = (v << 8n) | BigInt(o); }
  return v;
}
function v6ToBig(ip: string): bigint | null {
  let s = ip;
  // Strip zone id (fe80::1%eth0).
  const pct = s.indexOf('%'); if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':')) return null;
  // Embedded IPv4 tail (…:1.2.3.4) → two hextets.
  let tailV4 = '';
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const b = v4ToBig(tail); if (b === null) return null;
    const hi = (b >> 16n) & 0xffffn, lo = b & 0xffffn;
    tailV4 = `${hi.toString(16)}:${lo.toString(16)}`;
    s = s.slice(0, lastColon + 1) + tailV4;
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tailParts = dbl.length === 2 ? (dbl[1] ? dbl[1].split(':') : []) : [];
  if (dbl.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tailParts.length;
  if (fill < 0) return null;
  const groups = dbl.length === 2
    ? [...head, ...Array(fill).fill('0'), ...tailParts]
    : head;
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

const B32 = (a: number, b: number, c: number, d: number) => (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | BigInt(d);
const inV4 = (ip: bigint, base: bigint, bits: number) => (ip >> BigInt(32 - bits)) === (base >> BigInt(32 - bits));

function classifyV4(ip: bigint): IpCategory {
  if (ip === B32(169, 254, 169, 254) || ip === B32(169, 254, 170, 2)) return 'metadata'; // AWS/GCP/Azure IMDS + ECS
  if (ip === B32(0, 0, 0, 0)) return 'unspecified';
  if (inV4(ip, B32(127, 0, 0, 0), 8)) return 'loopback';
  if (inV4(ip, B32(169, 254, 0, 0), 16)) return 'linklocal';
  if (inV4(ip, B32(10, 0, 0, 0), 8) || inV4(ip, B32(172, 16, 0, 0), 12) || inV4(ip, B32(192, 168, 0, 0), 16) || inV4(ip, B32(100, 64, 0, 0), 10)) return 'private';
  if (inV4(ip, B32(224, 0, 0, 0), 4)) return 'multicast';
  if (inV4(ip, B32(0, 0, 0, 0), 8) || inV4(ip, B32(192, 0, 0, 0), 24) || inV4(ip, B32(192, 0, 2, 0), 24) || inV4(ip, B32(198, 18, 0, 0), 15) || inV4(ip, B32(198, 51, 100, 0), 24) || inV4(ip, B32(203, 0, 113, 0), 24) || inV4(ip, B32(240, 0, 0, 0), 4)) return 'reserved';
  return 'public';
}

const V6_MAPPED_PREFIX = 0xffffn;                // ::ffff:0:0/96   (top 96 bits = 0x…ffff)
const V6_NAT64_PREFIX = 0x0064ff9bn << 64n;      // 64:ff9b::/96    (top 96 bits)
const V6_AWS_IMDS = (0xfd00n << 112n) | (0x0ec2n << 96n) | 0x254n; // fd00:ec2::254
function classifyV6(ip: bigint): IpCategory {
  if (ip === 0n) return 'unspecified';
  if (ip === 1n) return 'loopback';
  // AWS IPv6 instance-metadata — always metadata (checked before the ULA range it sits in).
  if (ip === V6_AWS_IMDS) return 'metadata';
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) → classify the embedded v4.
  if ((ip >> 32n) === V6_MAPPED_PREFIX) return classifyV4(ip & 0xffffffffn);
  if ((ip >> 32n) === V6_NAT64_PREFIX) return classifyV4(ip & 0xffffffffn);
  const top16 = ip >> 112n;
  if ((top16 & 0xffc0n) === 0xfe80n) return 'linklocal';   // fe80::/10
  if ((top16 & 0xfe00n) === 0xfc00n) return 'private';     // fc00::/7 (ULA)
  if ((top16 & 0xff00n) === 0xff00n) return 'multicast';   // ff00::/8
  return 'public';
}

/** Classify a literal IP string. Non-IP input returns 'public' (hostnames are resolved elsewhere). */
export function classifyIp(ip: string): IpCategory {
  const fam = net.isIP(ip);
  if (fam === 4) return classifyV4(v4ToBig(ip)!);
  if (fam === 6) { const b = v6ToBig(ip); return b === null ? 'reserved' : classifyV6(b); }
  return 'public';
}

/** The reason an IP is disallowed under the active policy, or null if allowed. */
export function blockReasonForIp(ip: string, allowPrivate = envAllowPrivate()): string | null {
  const cat = classifyIp(ip);
  if (cat === 'metadata') return 'cloud metadata endpoint';
  if (cat === 'unspecified' || cat === 'multicast' || cat === 'reserved') return `${cat} address`;
  if (cat === 'loopback' || cat === 'linklocal' || cat === 'private') return allowPrivate ? null : `${cat} address`;
  return null;
}

function lookupAll(hostname: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err); else resolve(addresses as { address: string; family: number }[]);
    });
  });
}

/**
 * Pre-flight guard for a direct fetch: reject a non-http(s) scheme or a host that
 * resolves to a blocked address. Throws `Error` with an `SSRF blocked: …` message.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('SSRF blocked: invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`SSRF blocked: scheme "${u.protocol}" is not allowed`);
  const host = normalizeHost(u.hostname);
  if (allowedHosts().has(host)) return;
  let addrs: { address: string }[];
  try { addrs = await lookupAll(host); } catch (e) { throw new Error(`SSRF blocked: cannot resolve host "${host}" (${(e as Error).message})`); }
  const allowPrivate = envAllowPrivate();
  for (const a of addrs) {
    const reason = blockReasonForIp(a.address, allowPrivate);
    if (reason) throw new Error(`SSRF blocked: ${host} resolves to ${a.address} (${reason})`);
  }
}

/**
 * An undici `connect.lookup` that validates every resolved IP at connect time —
 * so it blocks redirect hops and DNS-rebinding, not just the first URL. Drop it
 * into any undici Agent's `connect` options.
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupAllOptions | dns.LookupOneOptions | Record<string, unknown>,
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
): void {
  const host = normalizeHost(hostname);
  const allow = allowedHosts().has(host);
  dns.lookup(hostname, { ...(options as object), all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as { address: string; family: number }[];
    if (!allow) {
      const allowPrivate = envAllowPrivate();
      for (const a of list) {
        const reason = blockReasonForIp(a.address, allowPrivate);
        if (reason) return callback(Object.assign(new Error(`SSRF blocked: ${host} resolves to ${a.address} (${reason})`), { code: 'ESSRFBLOCKED' }));
      }
    }
    if ((options as dns.LookupAllOptions)?.all) return callback(null, list as any);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

// ── shared guarded dispatcher (undici Agent) ────────────────────────────────
let cachedDispatcher: unknown;
/** A shared undici Agent whose connect step runs `guardedLookup`. Lazily built. */
export async function getSsrfDispatcher(): Promise<unknown> {
  if (cachedDispatcher) return cachedDispatcher;
  const undici: any = await import('undici');
  cachedDispatcher = new undici.Agent({ connect: { lookup: guardedLookup } });
  return cachedDispatcher;
}

/** The `connect.lookup` to merge into a caller-built undici Agent (e.g. mTLS). */
export const ssrfConnectLookup = guardedLookup;
