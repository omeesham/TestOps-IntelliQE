/**
 * api-auth-advanced.ts — advanced request-auth signing for the interactive
 * "Send" path (Digest, AWS Signature v4, OAuth 1.0a). Pure `node:crypto`, no
 * network and no deps, so the HTTP helper stays dependency-free. mTLS is handled
 * at the call site (it needs an undici dispatcher), not here.
 *
 * Each scheme is verified against a published test vector — see the sanity
 * script run at build time (scratchpad) / the session notes.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

/** RFC 3986 percent-encoding (encodeURIComponent + the four it leaves reserved). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/* ────────────────────────────────────────────────────────────────
   AWS Signature v4
   ──────────────────────────────────────────────────────────────── */

export interface AwsSigV4Config {
  accessKeyId?: string; secretAccessKey?: string; region?: string; service?: string; sessionToken?: string;
}

/**
 * Compute the AWS SigV4 headers for a request. Returns the headers to merge
 * (Authorization, x-amz-date, x-amz-content-sha256, optional x-amz-security-token).
 * `signContentSha256` is true for real sends (most AWS services require the
 * payload hash to be signed); set false to reproduce the published get-vanilla
 * test vector, which signs only host + x-amz-date.
 */
export function signAwsSigV4(opts: {
  method: string; url: string; body?: string; cfg: AwsSigV4Config; now?: Date; signContentSha256?: boolean;
}): Record<string, string> {
  const { cfg } = opts;
  const method = (opts.method || 'GET').toUpperCase();
  const u = new URL(opts.url);
  const region = cfg.region || 'us-east-1';
  const service = cfg.service || 'execute-api';
  const now = opts.now || new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(opts.body || '');
  const signContent = opts.signContentSha256 !== false;

  const canonHeaders: Record<string, string> = { host: u.host, 'x-amz-date': amzDate };
  if (signContent) canonHeaders['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(canonHeaders).sort();
  const canonicalHeaders = names.map((n) => `${n}:${canonHeaders[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const qp = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const canonicalQuery = qp.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalUri = u.pathname.split('/').map((seg) => rfc3986(seg)).join('/') || '/';

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac256('AWS4' + (cfg.secretAccessKey || ''), dateStamp);
  const kRegion = hmac256(kDate, region);
  const kService = hmac256(kRegion, service);
  const kSigning = hmac256(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const out: Record<string, string> = {
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId || ''}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
  };
  if (signContent) out['x-amz-content-sha256'] = payloadHash;
  if (cfg.sessionToken) out['x-amz-security-token'] = cfg.sessionToken;
  return out;
}

/* ────────────────────────────────────────────────────────────────
   OAuth 1.0a (one-legged / two-legged signing)
   ──────────────────────────────────────────────────────────────── */

export interface OAuth1Config {
  consumerKey?: string; consumerSecret?: string; token?: string; tokenSecret?: string; signatureMethod?: string;
}

/** Build the `Authorization: OAuth ...` header for a request. */
export function buildOAuth1Header(method: string, url: string, cfg: OAuth1Config, opts?: {
  timestamp?: string; nonce?: string; extraParams?: Record<string, string>;
}): string {
  const u = new URL(url);
  const sigMethod = (cfg.signatureMethod || 'HMAC-SHA1').toUpperCase();
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: cfg.consumerKey || '',
    oauth_nonce: opts?.nonce || randomBytes(16).toString('hex'),
    oauth_signature_method: sigMethod,
    oauth_timestamp: opts?.timestamp || String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  if (cfg.token) oauthParams.oauth_token = cfg.token;

  // Signature base string: oauth_* + query params + extra (form-urlencoded body).
  const all: [string, string][] = [];
  for (const [k, v] of Object.entries(oauthParams)) all.push([k, v]);
  for (const [k, v] of u.searchParams.entries()) all.push([k, v]);
  if (opts?.extraParams) for (const [k, v] of Object.entries(opts.extraParams)) all.push([k, v]);
  const encoded = all
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const paramString = encoded.map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const baseString = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(paramString)].join('&');
  const signingKey = `${rfc3986(cfg.consumerSecret || '')}&${rfc3986(cfg.tokenSecret || '')}`;

  let signature: string;
  if (sigMethod === 'HMAC-SHA256') signature = createHmac('sha256', signingKey).update(baseString).digest('base64');
  else if (sigMethod === 'PLAINTEXT') signature = signingKey;
  else signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;

  const headerParams = Object.keys(oauthParams).sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(oauthParams[k]!)}"`)
    .join(', ');
  return `OAuth ${headerParams}`;
}

/* ────────────────────────────────────────────────────────────────
   HTTP Digest (RFC 2617 / 7616) — challenge → response
   ──────────────────────────────────────────────────────────────── */

/** Parse a `WWW-Authenticate: Digest ...` challenge into a field map. */
export function parseDigestChallenge(header: string): Record<string, string> {
  const h = (header || '').replace(/^Digest\s+/i, '');
  const out: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h))) out[m[1]!.toLowerCase()] = (m[2] !== undefined ? m[2] : (m[3] || '')).trim();
  return out;
}

export interface DigestConfig { username?: string; password?: string; algorithm?: string }

/** Build the `Authorization: Digest ...` header for a parsed challenge. */
export function buildDigestHeader(opts: {
  challenge: Record<string, string>; method: string; uri: string;
  username: string; password: string; cnonce?: string; nc?: string;
}): string {
  const { challenge } = opts;
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const opaque = challenge.opaque;
  const algorithm = challenge.algorithm || 'MD5';
  const qopOptions = (challenge.qop || '').split(',').map((s) => s.trim()).filter(Boolean);
  const qop = qopOptions.includes('auth') ? 'auth' : (qopOptions[0] || '');
  const cnonce = opts.cnonce || randomBytes(8).toString('hex');
  const nc = opts.nc || '00000001';
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');

  let ha1 = md5(`${opts.username}:${realm}:${opts.password}`);
  if (/-sess$/i.test(algorithm)) ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${opts.method.toUpperCase()}:${opts.uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${opts.username}"`, `realm="${realm}"`, `nonce="${nonce}"`,
    `uri="${opts.uri}"`, `response="${response}"`,
  ];
  if (algorithm) parts.push(`algorithm=${algorithm}`);
  if (qop) { parts.push(`qop=${qop}`); parts.push(`nc=${nc}`); parts.push(`cnonce="${cnonce}"`); }
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}
