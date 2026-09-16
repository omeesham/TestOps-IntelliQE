/**
 * ADA scan lifecycle: start a scan detached, expose live progress for polling,
 * persist the results when it finishes.
 *
 * The crawl itself runs in-process (a scan of 40 pages is a few minutes of
 * Playwright work). Progress lives in memory keyed by scan id; the UI polls
 * `getProgress` with a cursor, which is the same short-request pattern the
 * pipeline stages use to survive the ~240s ingress limit on Azure.
 */
import pool from '../../db.js';
import { runScan, normaliseStartUrl, type EngineControl } from './ada-engine.js';
import { withRemediation } from './ada-remediation.js';
import type { SiteInventory } from './ada-inventory.js';
import type { Finding, LinkResult, PageResult, ProgressEvent, ScanOptions, ScanSummary } from './ada-types.js';

interface LiveScan {
  tenantId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  events: ProgressEvent[];
  /** `pages` = pages whose checks have finished; a page in progress is not counted until its audit is done. */
  counters: { pages: number; discovered: number; linksFound: number; linksInternal: number; linksExternal: number; linksChecked: number; issues: number; maxPages: number; currentUrl?: string };
  control: EngineControl;
  startedAt: number;
  finishedAt?: number;
  summary?: ScanSummary;
  inventory?: SiteInventory;
  error?: string;
}

const live = new Map<string, LiveScan>();
const MAX_EVENTS_KEPT = 2000;
const FINISHED_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT_SCANS = 2;

function sweep() {
  const now = Date.now();
  for (const [id, s] of live) if (s.finishedAt && now - s.finishedAt > FINISHED_TTL_MS) live.delete(id);
}

export function runningScanCount(): number {
  return [...live.values()].filter((s) => s.status === 'running').length;
}

export function tenantHasRunningScan(tenantId: string): string | null {
  for (const [id, s] of live) if (s.tenantId === tenantId && s.status === 'running') return id;
  return null;
}

/** Whole-site by default: the crawler discovers the pages itself; maxPages is only a safety ceiling. */
export const DEFAULT_OPTIONS: Omit<ScanOptions, 'url'> = {
  maxPages: 500,
  maxDepth: 12,
  useSitemap: true,
  checkExternalLinks: true,
  crawlDelayMs: 400,
};

export async function startScan(tenantId: string, createdBy: string, options: ScanOptions): Promise<string> {
  sweep();
  if (runningScanCount() >= MAX_CONCURRENT_SCANS) {
    throw new Error('Two audits are already running. Please wait for one to finish.');
  }
  const startUrl = normaliseStartUrl(options.url);
  const { rows } = await pool.query(
    `INSERT INTO ada_scans (tenant_id, target_url, status, config_data, created_by, started_at)
     VALUES ($1, $2, 'running', $3, $4, now())
     RETURNING id`,
    [tenantId, startUrl, JSON.stringify({ ...options, url: startUrl, password: options.password ? '***' : undefined }), createdBy],
  );
  const scanId: string = rows[0].id;

  const state: LiveScan = {
    tenantId, status: 'running', events: [], control: { cancelled: false },
    counters: { pages: 0, discovered: 0, linksFound: 0, linksInternal: 0, linksExternal: 0, linksChecked: 0, issues: 0, maxPages: options.maxPages },
    startedAt: Date.now(),
  };
  live.set(scanId, state);

  const emit = (e: Omit<ProgressEvent, 'seq' | 'at'>) => {
    const ev: ProgressEvent = { ...e, seq: state.events.length + 1, at: new Date().toISOString() };
    state.events.push(ev);
    if (state.events.length > MAX_EVENTS_KEPT) state.events.splice(0, state.events.length - MAX_EVENTS_KEPT);
    const d = (e.data || {}) as Record<string, any>;
    if (e.type === 'navigate') state.counters.currentUrl = d.url;
    // The engine reports `audited` only for pages whose checks are complete — never for the page it is on.
    if (d.audited !== undefined) state.counters.pages = Number(d.audited);
    if (d.discovered !== undefined) state.counters.discovered = Math.max(state.counters.discovered, Number(d.discovered));
    if (e.type === 'sitemap' && d.count !== undefined) state.counters.discovered = Math.max(state.counters.discovered, Number(d.count));
    if (e.type === 'sitemap' && d.inventory) state.inventory = d.inventory as SiteInventory;
    if (d.linksFound !== undefined) {
      state.counters.linksFound = Number(d.linksFound);
      state.counters.linksInternal = Number(d.linksInternal || 0);
      state.counters.linksExternal = Number(d.linksExternal || 0);
    }
    if (e.type === 'accessibility') state.counters.issues += Number(d.violations || 0);
    if (e.type === 'best-practice') state.counters.issues += Number(d.failed || 0);
    if (e.type === 'links' && d.done !== undefined) state.counters.linksChecked = Number(d.done);
    if (e.type === 'link-check') state.counters.issues += 1;
  };

  // Detached — the HTTP request that started the scan returns immediately.
  (async () => {
    try {
      const result = await runScan({ ...options, url: startUrl }, emit, state.control);
      const finalStatus = state.control.cancelled ? 'cancelled' : 'completed';
      await persist(scanId, tenantId, result.pages, result.links, result.summary, finalStatus);
      state.summary = result.summary;
      state.status = finalStatus;
      state.finishedAt = Date.now();
      emit({ type: 'done', message: finalStatus === 'cancelled' ? 'Stopped early — the report covers the pages audited so far.' : 'Audit complete.', data: { status: finalStatus } });
      await saveLog(scanId, state.events);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      state.status = 'failed';
      state.error = msg;
      state.finishedAt = Date.now();
      emit({ type: 'error', message: `Audit failed: ${msg}` });
      await pool.query(`UPDATE ada_scans SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [scanId, msg]).catch(() => { /* logged below */ });
      await saveLog(scanId, state.events);
      console.error(`[ada] scan ${scanId} failed:`, msg);
    }
  })();

  return scanId;
}

export function cancelScan(tenantId: string, scanId: string): boolean {
  const s = live.get(scanId);
  if (!s || s.tenantId !== tenantId || s.status !== 'running') return false;
  s.control.cancelled = true;
  return true;
}

export function getProgress(tenantId: string, scanId: string, afterSeq = 0) {
  const s = live.get(scanId);
  if (!s || s.tenantId !== tenantId) return null;
  return {
    status: s.status,
    counters: s.counters,
    events: s.events.filter((e) => e.seq > afterSeq).slice(-300),
    lastSeq: s.events.length ? s.events[s.events.length - 1].seq : afterSeq,
    elapsedMs: (s.finishedAt || Date.now()) - s.startedAt,
    summary: s.summary,
    inventory: s.inventory,
    error: s.error,
  };
}

/* ───────────────────────────── persistence ───────────────────────────── */

/** The workflow log is kept with the scan so a report opened later still shows how the crawl went. */
async function saveLog(scanId: string, events: ProgressEvent[]): Promise<void> {
  await pool.query(`UPDATE ada_scans SET progress_log = $2 WHERE id = $1`, [scanId, JSON.stringify(events.slice(-1500))])
    .catch((err) => console.warn(`[ada] could not save workflow log for ${scanId}:`, (err as Error).message));
}

async function persist(scanId: string, tenantId: string, pages: PageResult[], links: LinkResult[], summary: ScanSummary, status: 'completed' | 'cancelled'): Promise<void> {
  const findings: Finding[] = pages.flatMap((p) => p.findings);
  // Broken links become findings too, so one table answers "what is wrong".
  for (const l of links) {
    if (l.ok || l.kind === 'skipped' || l.kind === 'blocked') continue;
    const sev = l.kind === 'broken' ? 'serious' : l.kind === 'server-error' ? 'critical' : 'moderate';
    findings.push({
      pageUrl: l.referrers[0] || summary.targetUrl,
      category: 'links',
      ruleId: l.kind === 'broken' ? `http-${l.status ?? 'error'}` : l.kind,
      severity: sev,
      title: l.kind === 'broken' ? `Broken link (HTTP ${l.status})` : l.kind === 'server-error' ? `Server error (HTTP ${l.status})` : l.kind === 'timeout' ? 'Link timed out' : 'Link could not be reached',
      description: `${l.external ? 'External' : 'Internal'} link ${l.url}${l.linkText ? ` ("${l.linkText}")` : ''}${l.error ? ` — ${l.error}` : ''} referenced from ${l.referrers.length} page${l.referrers.length === 1 ? '' : 's'}.`,
      element: l.url.slice(0, 1000),
      occurrences: l.referrers.length,
      details: { link: l.url, status: l.status, external: l.external, referrers: l.referrers, finalUrl: l.finalUrl, linkText: l.linkText },
    });
  }

  await batchInsert(
    'ada_pages',
    ['scan_id', 'tenant_id', 'url', 'title', 'status_code', 'depth', 'parent_url', 'source', 'load_ms', 'links_found', 'a11y_score', 'bp_score', 'findings_count'],
    pages.map((p) => [scanId, tenantId, p.url.slice(0, 2000), (p.title || '').slice(0, 500), p.statusCode, p.depth, (p.parentUrl || '').slice(0, 2000) || null, p.source, p.loadMs, p.linksFound, p.a11yScore, p.bpScore, p.findings.reduce((a, f) => a + f.occurrences, 0)]),
  );
  // Every finding carries its own problem / fix / example so the report is self-contained.
  const enriched = findings.map(withRemediation);

  await batchInsert(
    'ada_findings',
    ['scan_id', 'tenant_id', 'page_url', 'category', 'rule_id', 'severity', 'title', 'description', 'wcag', 'element', 'html_snippet', 'help_url', 'occurrences', 'details'],
    enriched.map((f) => [scanId, tenantId, f.pageUrl.slice(0, 2000), f.category, f.ruleId.slice(0, 100), f.severity, f.title.slice(0, 500), f.description || null, f.wcag || null, f.element || null, f.htmlSnippet || null, f.helpUrl || null, f.occurrences, f.details ? JSON.stringify(f.details) : null]),
  );

  await pool.query(
    `UPDATE ada_scans
        SET status = $8, result = $2, site_name = $3, pages_crawled = $4, links_checked = $5,
            findings_count = $6, overall_score = $7, finished_at = now()
      WHERE id = $1`,
    [scanId, JSON.stringify(summary), summary.siteName.slice(0, 200), pages.length, summary.linksChecked,
      findings.reduce((a, f) => a + f.occurrences, 0), summary.overall.score, status],
  );
}

/** Multi-row INSERT in chunks that stay under SQL Server's 2100-parameter limit. */
async function batchInsert(table: string, cols: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const chunk = Math.max(1, Math.floor(2000 / cols.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = slice.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`).join(',\n');
    await pool.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}`, params);
  }
}
