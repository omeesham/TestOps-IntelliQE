/**
 * api-cloud-lab.service.ts
 * ────────────────────────
 * Cloud browser/device lab — run the SAME UI checks as the API+UI hybrid test
 * on HOSTED real browsers via a provider grid instead of only local Chromium:
 *
 *   • BrowserStack  — caps-in-URL, wss://cdp.browserstack.com/playwright
 *   • LambdaTest    — caps-in-URL, wss://cdp.lambdatest.com/playwright
 *   • custom        — any raw Playwright WebSocket endpoint (Sauce Labs,
 *                     Selenium Grid, Moon, a self-hosted grid)
 *
 * It connects Playwright to the remote grid with `chromium.connect(ws)` rather
 * than launching a local browser, so the same checks run across a MATRIX of
 * browser / OS combinations and come back with a pass/fail + screenshot per
 * target.
 *
 * Fully additive and opt-in: its own `api_cloud_labs` config table; the
 * generate → execute → heal pipeline never touches it. Provider credentials are
 * AES-encrypted at rest and only ever returned masked. Robustness invariant
 * (same as the Web Lab / hybrid test): every target resolves to a result object
 * — a connection/auth/parallel-limit failure degrades to an error string on
 * that one target and NEVER throws out of the matrix.
 */
import { createRequire } from 'node:module';
import pool from '../db.js';
import { encryptAtRest, decryptStored, maskSecret, isMaskedSecret } from '../utils/crypto.js';
import { assertWebUrl } from './web-browser.service.js';
import { substitute, evalUiCheck, type UiCheck } from './api-hybrid.service.js';

const requireCjs = createRequire(import.meta.url);

export type CloudProvider = 'browserstack' | 'lambdatest' | 'custom';
const PROVIDERS: CloudProvider[] = ['browserstack', 'lambdatest', 'custom'];

/** One browser/OS combination to run the checks on. */
export interface CloudTarget {
  browser?: string;        // chrome / edge / firefox / webkit / playwright-chromium …
  browserVersion?: string; // 'latest'
  os?: string;             // 'Windows' / 'OS X' / 'Windows 11' …
  osVersion?: string;      // '11' / 'Sonoma'
  label?: string;          // display label (derived when absent)
}

/** Safe view returned to the client — never carries the raw secret. */
export interface CloudLabConfig {
  id: string;
  name: string;
  provider: CloudProvider;
  username: string;
  enabled: boolean;
  hasAccessKey: boolean;
  hasWsEndpoint: boolean;
  accessKeyMasked?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudCheckOutcome { label: string; pass: boolean; detail?: string }
export interface CloudTargetResult {
  label: string;
  target: CloudTarget;
  reached: boolean;
  passed: boolean;
  checks: CloudCheckOutcome[];
  screenshotBase64?: string;
  title?: string;
  finalUrl?: string;
  durationMs: number;
  error?: string;
}
export interface CloudRunResult {
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  durationMs: number;
  url: string;
  provider: CloudProvider;
  results: CloudTargetResult[];
}

const CHECK_CAP = 30;
const TARGET_CAP = 6;
const GOTO_TIMEOUT = 45_000;
const CONNECT_TIMEOUT = 60_000;
const CONCURRENCY = 3; // cloud grids cap parallel sessions — stay conservative

// ─── config CRUD ────────────────────────────────────────────────────────────

function toView(r: any): CloudLabConfig {
  const ak = r.access_key ? safeDecrypt(r.access_key) : '';
  return {
    id: String(r.id),
    name: r.name || '',
    provider: (PROVIDERS.includes(r.provider) ? r.provider : 'custom') as CloudProvider,
    username: r.username || '',
    enabled: r.enabled === true || r.enabled === 1,
    hasAccessKey: !!r.access_key,
    hasWsEndpoint: !!r.ws_endpoint,
    accessKeyMasked: ak ? maskSecret(ak) : undefined,
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeDecrypt(v: string): string {
  try { return decryptStored(v); } catch { return ''; }
}

async function loadRow(tenantId: string, id: string): Promise<any | null> {
  if (!id) return null;
  const { rows } = await pool.query(`SELECT * FROM api_cloud_labs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? rows[0] : null;
}

export async function listCloudLabs(tenantId: string): Promise<CloudLabConfig[]> {
  const { rows } = await pool.query(`SELECT * FROM api_cloud_labs WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toView);
}

export async function saveCloudLab(tenantId: string, username: string, input: any): Promise<CloudLabConfig> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'Cloud lab';
  const provider: CloudProvider = PROVIDERS.includes(input?.provider) ? input.provider : 'custom';
  const user = String(input?.username || '').trim().slice(0, 200);
  const enabled = input?.enabled !== false;
  const rawKey = typeof input?.accessKey === 'string' ? input.accessKey.trim() : '';
  const rawWs = typeof input?.wsEndpoint === 'string' ? input.wsEndpoint.trim() : '';

  if (input?.id) {
    const existing = await loadRow(tenantId, String(input.id));
    if (!existing) throw new Error('Cloud lab not found.');
    // A missing or masked secret means "keep the stored value", never "clear it".
    const access_key = !rawKey || isMaskedSecret(rawKey) ? existing.access_key : encryptAtRest(rawKey);
    const ws_endpoint = !rawWs || isMaskedSecret(rawWs) ? existing.ws_endpoint : encryptAtRest(rawWs);
    const { rows } = await pool.query(
      `UPDATE api_cloud_labs SET name = $3, provider = $4, username = $5, access_key = $6, ws_endpoint = $7, enabled = $8, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, provider, user, access_key, ws_endpoint, enabled],
    );
    return toView(rows[0]);
  }

  const access_key = rawKey && !isMaskedSecret(rawKey) ? encryptAtRest(rawKey) : null;
  const ws_endpoint = rawWs && !isMaskedSecret(rawWs) ? encryptAtRest(rawWs) : null;
  const { rows } = await pool.query(
    `INSERT INTO api_cloud_labs (tenant_id, name, provider, username, access_key, ws_endpoint, enabled, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, name, provider, user, access_key, ws_endpoint, enabled, username],
  );
  return toView(rows[0]);
}

export async function deleteCloudLab(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_cloud_labs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── remote connection + run ──────────────────────────────────────────────────

/** The Playwright client version the grid should match itself to (best-effort). */
function playwrightClientVersion(): string | undefined {
  try { return String(requireCjs('@playwright/test/package.json')?.version || '') || undefined; }
  catch {
    try { return String(requireCjs('playwright-core/package.json')?.version || '') || undefined; }
    catch { return undefined; }
  }
}

/** Build the provider-specific wss:// CDP endpoint for one target. Throws only on misconfiguration. */
function wsEndpointFor(
  provider: CloudProvider,
  username: string,
  accessKey: string,
  wsEndpoint: string,
  target: CloudTarget,
  meta: { name: string; build: string },
): string {
  if (provider === 'custom') {
    if (!/^wss?:\/\//i.test(wsEndpoint)) throw new Error('This custom cloud lab has no valid ws:// / wss:// endpoint configured.');
    return wsEndpoint;
  }
  const ver = playwrightClientVersion();
  if (provider === 'browserstack') {
    if (!username || !accessKey) throw new Error('BrowserStack username and access key are required.');
    const caps: Record<string, unknown> = {
      browser: target.browser || 'chrome',
      browser_version: target.browserVersion || 'latest',
      os: target.os || 'Windows',
      os_version: target.osVersion || '11',
      name: meta.name,
      build: meta.build,
      'browserstack.username': username,
      'browserstack.accessKey': accessKey,
    };
    if (ver) caps['client.playwrightVersion'] = ver;
    return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;
  }
  // lambdatest
  if (!username || !accessKey) throw new Error('LambdaTest username and access key are required.');
  const ltOptions: Record<string, unknown> = {
    platform: target.os || 'Windows 11',
    build: meta.build,
    name: meta.name,
    user: username,
    accessKey,
  };
  if (ver) ltOptions.playwrightClientVersion = ver;
  const caps = {
    browserName: target.browser || 'Chrome',
    browserVersion: target.browserVersion || 'latest',
    'LT:Options': ltOptions,
  };
  return `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`;
}

function targetLabel(t: CloudTarget): string {
  return (
    t.label?.trim() ||
    [t.browser, t.browserVersion, t.os, t.osVersion].map((x) => String(x || '').trim()).filter(Boolean).join(' ') ||
    'browser'
  );
}

function cleanConnErr(e: unknown): string {
  const m = String((e as Error)?.message || e || '');
  if (/Executable doesn't exist|playwright install/i.test(m)) return 'The cloud lab needs the Playwright client installed on the server (npm i -D @playwright/test).';
  if (/\b401\b|\b403\b|unauthor|invalid.*(credential|access|key)|authentication/i.test(m)) return 'Authentication failed — check the provider username / access key.';
  if (/parallel|queue|sessions? limit|no (free|available)|busy|quota/i.test(m)) return 'The provider has no free parallel session right now — try fewer targets or wait a moment.';
  if (/timeout|timed out/i.test(m)) return 'Timed out connecting to the cloud grid.';
  if (/ENOTFOUND|ECONNREFUSED|getaddrinfo|socket hang up/i.test(m)) return 'Could not reach the cloud grid — check the endpoint and network egress.';
  return (m.slice(0, 400) || 'Could not connect to the cloud grid.');
}

async function runOneTarget(
  ws: string,
  target: CloudTarget,
  url: string,
  checks: UiCheck[],
  vars: Record<string, string>,
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | undefined,
): Promise<CloudTargetResult> {
  const started = Date.now();
  const label = targetLabel(target);
  let pw: typeof import('@playwright/test');
  try { pw = await import('@playwright/test'); }
  catch { return { label, target, reached: false, passed: false, checks: [], durationMs: Date.now() - started, error: 'The Playwright client is not installed on the server (npm i -D @playwright/test).' }; }

  let browser: Awaited<ReturnType<typeof pw.chromium.connect>> | null = null;
  try {
    browser = await pw.chromium.connect(ws, { timeout: CONNECT_TIMEOUT });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { timeout: GOTO_TIMEOUT, waitUntil: waitUntil || 'domcontentloaded' });

    const results: CloudCheckOutcome[] = [];
    for (const c of checks.slice(0, CHECK_CAP)) results.push(await evalUiCheck(page, c, vars));

    let shot: string | undefined;
    try { const buf = await page.screenshot({ type: 'png', fullPage: false }); shot = Buffer.from(buf).toString('base64'); } catch { /* screenshot optional */ }
    const title = await page.title().catch(() => '');
    const finalUrl = page.url();
    const passed = results.length > 0 && results.every((r) => r.pass);
    return { label, target, reached: true, passed, checks: results, screenshotBase64: shot, title: String(title), finalUrl, durationMs: Date.now() - started };
  } catch (e) {
    return { label, target, reached: false, passed: false, checks: [], durationMs: Date.now() - started, error: cleanConnErr(e) };
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

/** Run a small pool of thunks at a bounded concurrency, preserving order. */
async function runPool<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) || 0 }, async () => {
    while (next < thunks.length) {
      const idx = next++;
      out[idx] = await thunks[idx]!();
    }
  });
  await Promise.all(workers);
  return out;
}

/** Connect once to the grid with a trivial navigation to verify credentials/endpoint. */
export async function testCloudLab(tenantId: string, id: string): Promise<{ ok: boolean; detail: string; label?: string }> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Cloud lab not found.');
  const provider = (PROVIDERS.includes(row.provider) ? row.provider : 'custom') as CloudProvider;
  const username = row.username || '';
  const accessKey = row.access_key ? safeDecrypt(row.access_key) : '';
  const wsEndpoint = row.ws_endpoint ? safeDecrypt(row.ws_endpoint) : '';
  let ws: string;
  try { ws = wsEndpointFor(provider, username, accessKey, wsEndpoint, {}, { name: 'IntelliQE connection test', build: `intelliqe-${String(tenantId).slice(0, 8)}` }); }
  catch (e) { return { ok: false, detail: (e as Error).message }; }

  const r = await runOneTarget(ws, {}, 'https://example.com', [{ kind: 'titleContains', text: 'Example' }], {}, 'domcontentloaded');
  return r.reached
    ? { ok: true, detail: `Connected — reached ${r.finalUrl} in ${r.durationMs} ms.`, label: r.label }
    : { ok: false, detail: r.error || 'Connection failed.' };
}

/** Run the configured checks against `url` across every target, in parallel (bounded). */
export async function runCloudMatrix(
  tenantId: string,
  input: {
    configId?: string;
    url?: string;
    name?: string;
    targets?: CloudTarget[];
    checks?: UiCheck[];
    variables?: Record<string, string>;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  },
): Promise<CloudRunResult> {
  const started = Date.now();
  const row = await loadRow(tenantId, String(input?.configId || ''));
  if (!row) throw new Error('Select a cloud lab provider first.');
  if (!(row.enabled === true || row.enabled === 1)) throw new Error('This cloud lab is disabled — enable it before running.');

  const provider = (PROVIDERS.includes(row.provider) ? row.provider : 'custom') as CloudProvider;
  const username = row.username || '';
  const accessKey = row.access_key ? safeDecrypt(row.access_key) : '';
  const wsEndpoint = row.ws_endpoint ? safeDecrypt(row.ws_endpoint) : '';

  const vars = input?.variables && typeof input.variables === 'object' ? input.variables : {};
  const url = assertWebUrl(substitute(String(input?.url || ''), vars));
  const checks: UiCheck[] = Array.isArray(input?.checks) ? input.checks.slice(0, CHECK_CAP) : [];
  const waitUntil = input?.waitUntil;
  const targets: CloudTarget[] = Array.isArray(input?.targets) && input.targets.length ? input.targets.slice(0, TARGET_CAP) : [{}];
  const meta = { name: String(input?.name || 'IntelliQE cloud check').slice(0, 120), build: `intelliqe-${String(tenantId).slice(0, 8)}` };

  const thunks: Array<() => Promise<CloudTargetResult>> = targets.map((t) => {
    let ws: string;
    try { ws = wsEndpointFor(provider, username, accessKey, wsEndpoint, t, meta); }
    catch (e) {
      const msg = (e as Error).message;
      return async (): Promise<CloudTargetResult> => ({ label: targetLabel(t), target: t, reached: false, passed: false, checks: [], durationMs: 0, error: msg });
    }
    return () => runOneTarget(ws, t, url, checks, vars, waitUntil);
  });

  const results = await runPool(thunks, CONCURRENCY);
  const passedCount = results.filter((r) => r.passed).length;
  const passed = results.length > 0 && passedCount === results.length;
  return { passed, total: results.length, passedCount, failedCount: results.length - passedCount, durationMs: Date.now() - started, url, provider, results };
}
