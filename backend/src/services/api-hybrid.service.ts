/**
 * api-hybrid.service.ts
 * ─────────────────────
 * API + UI hybrid test — the Testsigma-style headline journey: SEED state via
 * API calls, VERIFY it in a real browser (Playwright), then CLEAN UP via API —
 * all in one test. Seed/cleanup reuse the flow engine (runFlow, with {{var}}
 * capture carried into the UI step); the UI step reuses the Web Lab's
 * `withPage` launcher. Variables extracted during seed substitute into the UI
 * url and into text/selector checks.
 *
 * Fully additive and opt-in: its own table, never touched by the pipeline. If
 * Chromium isn't installed the UI step reports that cleanly and the API
 * seed/cleanup still run.
 */
import pool from '../db.js';
import { runFlow, getStepGroupMap, type FlowStep, type FlowRunResult } from './api-flow.service.js';
import { withPage, assertWebUrl, BrowserNotInstalledError, type WebEngine } from './web-browser.service.js';

export type UiCheckKind = 'textPresent' | 'textAbsent' | 'selectorPresent' | 'selectorCount' | 'titleContains' | 'urlContains';
export interface UiCheck { kind: UiCheckKind; selector?: string; text?: string; count?: number }
export interface HybridUi {
  url: string;
  engine?: WebEngine;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  checks: UiCheck[];
}
export interface HybridTest {
  id: string;
  name: string;
  seed: FlowStep[];
  ui: HybridUi;
  cleanup: FlowStep[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function substitute(text: string, vars: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k) => (k in vars ? vars[k]! : `{{${k}}}`));
}

function mapRow(r: any): HybridTest {
  return {
    id: String(r.id), name: r.name,
    seed: Array.isArray(r.seed) ? r.seed : [],
    ui: r.ui && typeof r.ui === 'object' ? r.ui : { url: '', checks: [] },
    cleanup: Array.isArray(r.cleanup) ? r.cleanup : [],
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listHybridTests(tenantId: string): Promise<HybridTest[]> {
  const { rows } = await pool.query(`SELECT * FROM api_hybrid_tests WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapRow);
}
export async function getHybridTest(tenantId: string, id: string): Promise<HybridTest | null> {
  const { rows } = await pool.query(`SELECT * FROM api_hybrid_tests WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? mapRow(rows[0]) : null;
}
export async function saveHybridTest(tenantId: string, username: string, input: any): Promise<HybridTest> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'Hybrid test';
  const seed: FlowStep[] = Array.isArray(input?.seed) ? input.seed.slice(0, 40) : [];
  const cleanup: FlowStep[] = Array.isArray(input?.cleanup) ? input.cleanup.slice(0, 40) : [];
  const ui: HybridUi = input?.ui && typeof input.ui === 'object'
    ? { url: String(input.ui.url || ''), engine: input.ui.engine, waitUntil: input.ui.waitUntil, checks: Array.isArray(input.ui.checks) ? input.ui.checks.slice(0, 30) : [] }
    : { url: '', checks: [] };
  if (input?.id) {
    const { rows } = await pool.query(
      `UPDATE api_hybrid_tests SET name = $3, seed = $4, ui = $5, cleanup = $6, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, seed, ui, cleanup],
    );
    if (!rows.length) throw new Error('Hybrid test not found.');
    return mapRow(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_hybrid_tests (tenant_id, name, seed, ui, cleanup, created_by) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, name, seed, ui, cleanup, username],
  );
  return mapRow(rows[0]);
}
export async function deleteHybridTest(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_hybrid_tests WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface HybridUiResult {
  reached: boolean;
  checks: { label: string; pass: boolean; detail?: string }[];
  screenshotBase64?: string;
  title?: string;
  finalUrl?: string;
  error?: string;
}
export interface HybridRunResult {
  passed: boolean;
  durationMs: number;
  seed: FlowRunResult;
  ui: HybridUiResult;
  cleanup: FlowRunResult;
  variables: Record<string, string>;
}

export async function evalUiCheck(page: any, c: UiCheck, vars: Record<string, string>): Promise<{ label: string; pass: boolean; detail?: string }> {
  try {
    if (c.kind === 'textPresent') { const t = substitute(c.text || '', vars); const body = await page.content(); const pass = body.includes(t); return { label: `page contains "${t}"`, pass, detail: pass ? undefined : 'not found in page HTML' }; }
    if (c.kind === 'textAbsent') { const t = substitute(c.text || '', vars); const body = await page.content(); return { label: `page omits "${t}"`, pass: !body.includes(t) }; }
    if (c.kind === 'selectorPresent') { const sel = c.selector || ''; const n = await page.locator(sel).count(); return { label: `selector ${sel} present`, pass: n > 0, detail: `found ${n}` }; }
    if (c.kind === 'selectorCount') { const sel = c.selector || ''; const n = await page.locator(sel).count(); return { label: `selector ${sel} count = ${c.count ?? 0}`, pass: n === (c.count ?? 0), detail: `found ${n}` }; }
    if (c.kind === 'titleContains') { const t = substitute(c.text || '', vars); const title = await page.title(); return { label: `title contains "${t}"`, pass: String(title).includes(t), detail: String(title) }; }
    if (c.kind === 'urlContains') { const t = substitute(c.text || '', vars); const u = page.url(); return { label: `url contains "${t}"`, pass: String(u).includes(t), detail: String(u) }; }
    return { label: 'unknown check', pass: false };
  } catch (e) {
    return { label: `check ${c.kind}`, pass: false, detail: (e as Error).message };
  }
}

export async function runHybrid(
  tenantId: string,
  input: { seed?: FlowStep[]; ui?: HybridUi; cleanup?: FlowStep[]; variables?: Record<string, string>; allowWrites?: boolean },
): Promise<HybridRunResult> {
  const started = Date.now();
  const groups = await getStepGroupMap(tenantId).catch(() => ({} as Record<string, FlowStep[]>));
  const allowWrites = input?.allowWrites !== false;

  // 1) SEED via API
  const seed = await runFlow({ steps: Array.isArray(input?.seed) ? input!.seed! : [], variables: input?.variables || {}, allowWrites, groups });
  const vars: Record<string, string> = { ...seed.variables };

  // 2) VERIFY in a real browser
  let ui: HybridUiResult = { reached: false, checks: [] };
  const uiSpec = input?.ui;
  if (uiSpec && String(uiSpec.url || '').trim()) {
    try {
      const url = assertWebUrl(substitute(uiSpec.url, vars));
      ui = await withPage(url, async (page: any) => {
        const checks: HybridUiResult['checks'] = [];
        for (const c of (uiSpec.checks || []).slice(0, 30)) checks.push(await evalUiCheck(page, c, vars));
        let shot: string | undefined;
        try { const buf = await page.screenshot({ type: 'png', fullPage: false }); shot = Buffer.from(buf).toString('base64'); } catch { /* screenshot optional */ }
        const title = await page.title().catch(() => '');
        return { reached: true, checks, screenshotBase64: shot, title: String(title), finalUrl: page.url() };
      }, { engine: uiSpec.engine, waitUntil: uiSpec.waitUntil || 'domcontentloaded', gotoTimeoutMs: 30_000 });
    } catch (e) {
      ui = e instanceof BrowserNotInstalledError
        ? { reached: false, checks: [], error: `${e.message} — the API seed/cleanup still ran.` }
        : { reached: false, checks: [], error: (e as Error).message };
    }
  } else {
    ui = { reached: false, checks: [], error: 'No UI URL configured for the verify step.' };
  }

  // 3) CLEAN UP via API
  const cleanup = await runFlow({ steps: Array.isArray(input?.cleanup) ? input!.cleanup! : [], variables: vars, allowWrites, groups });

  const uiPass = ui.reached && ui.checks.length > 0 && ui.checks.every((c) => c.pass);
  const passed = seed.passed && uiPass && cleanup.passed;
  return { passed, durationMs: Date.now() - started, seed, ui, cleanup, variables: vars };
}
