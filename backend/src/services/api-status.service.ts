/**
 * api-status.service.ts
 * ─────────────────────
 * Multi-region synthetic monitoring + SLO/uptime + a public status page — the
 * Checkly / Datadog-Synthetics slice api-monitor (single-node, alert-only)
 * doesn't cover. A "status page" probes a set of target URLs (optionally through
 * per-region egress proxies), records latency/availability over time, computes
 * uptime% + p95 against an SLO, and publishes a shareable public page at
 * /status/:token. An in-process poller refreshes enabled pages periodically.
 *
 * Standalone, opt-in. Management is tenant-authenticated; the status page is
 * public (unguessable token). Reuses the shared HTTP helper; no pipeline coupling.
 */
import { randomBytes } from 'node:crypto';
import pool from '../db.js';
import { timedFetch } from '../utils/api-http.js';

export interface StatusTarget { name: string; method: string; url: string }
export interface StatusRegion { id: string; proxyUrl?: string }
export interface StatusSlo { uptimePct: number; p95Ms: number }
export interface StatusPage { id: string; token: string; name: string; targets: StatusTarget[]; regions: StatusRegion[]; slo: StatusSlo; enabled: boolean; createdBy: string; createdAt: string; updatedAt: string }

function parse<T>(s: any, d: T): T { try { return JSON.parse(s); } catch { return d; } }
function mapPage(r: any): StatusPage {
  return { id: String(r.id), token: r.token, name: r.name || 'Status', targets: parse(r.targets, []), regions: parse(r.regions, [{ id: 'origin' }]), slo: parse(r.slo, { uptimePct: 99, p95Ms: 800 }), enabled: !!r.enabled, createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at };
}

export async function listStatusPages(tenantId: string): Promise<StatusPage[]> {
  const { rows } = await pool.query(`SELECT * FROM api_status_pages WHERE tenant_id=$1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapPage);
}
export async function getStatusPage(tenantId: string, id: string): Promise<StatusPage | null> {
  const { rows } = await pool.query(`SELECT * FROM api_status_pages WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  return rows.length ? mapPage(rows[0]) : null;
}
export async function saveStatusPage(tenantId: string, username: string, input: any): Promise<StatusPage> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'API status';
  const targets: StatusTarget[] = (Array.isArray(input?.targets) ? input.targets : []).slice(0, 30).map((t: any) => ({ name: String(t?.name || t?.url || 'target').slice(0, 120), method: String(t?.method || 'GET').toUpperCase(), url: String(t?.url || '') })).filter((t: StatusTarget) => /^https?:\/\//i.test(t.url));
  if (!targets.length) throw new Error('Add at least one target with an absolute URL.');
  const regions: StatusRegion[] = (Array.isArray(input?.regions) && input.regions.length ? input.regions : [{ id: 'origin' }]).slice(0, 6).map((r: any) => ({ id: String(r?.id || 'origin').slice(0, 40), proxyUrl: r?.proxyUrl ? String(r.proxyUrl).slice(0, 300) : undefined }));
  const slo: StatusSlo = { uptimePct: Math.min(100, Math.max(0, Number(input?.slo?.uptimePct) || 99)), p95Ms: Math.max(1, Number(input?.slo?.p95Ms) || 800) };
  if (input?.id) {
    const { rowCount } = await pool.query(`UPDATE api_status_pages SET name=$3, targets=$4, regions=$5, slo=$6, updated_at=SYSUTCDATETIME() WHERE tenant_id=$1 AND id=$2`, [tenantId, String(input.id), name, JSON.stringify(targets), JSON.stringify(regions), JSON.stringify(slo)]);
    if (rowCount) { const p = await getStatusPage(tenantId, String(input.id)); if (p) return p; }
  }
  const token = randomBytes(12).toString('hex');
  const { rows } = await pool.query(`INSERT INTO api_status_pages (tenant_id, token, name, targets, regions, slo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [tenantId, token, name, JSON.stringify(targets), JSON.stringify(regions), JSON.stringify(slo), username || '']);
  return mapPage(rows[0]);
}
export async function setStatusEnabled(tenantId: string, id: string, enabled: boolean): Promise<StatusPage | null> {
  const { rowCount } = await pool.query(`UPDATE api_status_pages SET enabled=$3, updated_at=SYSUTCDATETIME() WHERE tenant_id=$1 AND id=$2`, [tenantId, id, enabled ? 1 : 0]);
  if (!rowCount) return null;
  return getStatusPage(tenantId, id);
}
export async function deleteStatusPage(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_status_pages WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  await pool.query(`DELETE FROM api_status_checks WHERE tenant_id=$1 AND page_id=$2`, [tenantId, id]).catch(() => {});
  return rowCount > 0;
}

async function proxyDispatcher(proxyUrl?: string): Promise<any> {
  if (!proxyUrl) return undefined;
  try { const spec = 'undici'; const { ProxyAgent } = await import(spec); return new ProxyAgent(proxyUrl); } catch { return undefined; }
}

/** Probe every target × region once, record the checks, prune old rows. */
export async function probeStatusPage(tenantId: string, page: StatusPage): Promise<{ probed: number }> {
  let probed = 0;
  for (const region of page.regions) {
    const dispatcher = await proxyDispatcher(region.proxyUrl);
    for (const t of page.targets) {
      const init: any = { method: t.method || 'GET' };
      if (dispatcher) init.dispatcher = dispatcher;
      const r = await timedFetch(t.url, init, 15000);
      await pool.query(`INSERT INTO api_status_checks (tenant_id, page_id, target_name, region, ok, status, ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, page.id, t.name.slice(0, 120), region.id, r.ok ? 1 : 0, r.status ?? null, r.elapsedMs]).catch(() => {});
      probed++;
    }
  }
  // Prune to newest 2000 checks per page.
  await pool.query(`DELETE FROM api_status_checks WHERE tenant_id=$1 AND page_id=$2 AND id NOT IN (SELECT TOP 2000 id FROM api_status_checks WHERE tenant_id=$1 AND page_id=$2 ORDER BY created_at DESC)`, [tenantId, page.id]).catch(() => {});
  return { probed };
}

export async function probeNow(tenantId: string, id: string): Promise<{ probed: number }> {
  const page = await getStatusPage(tenantId, id);
  if (!page) throw new Error('Status page not found.');
  return probeStatusPage(tenantId, page);
}

export interface TargetStatus { name: string; uptimePct: number; p95Ms: number; avgMs: number; samples: number; lastOk: boolean; lastStatus: number | null; sloMet: boolean }
export interface StatusView { name: string; targets: TargetStatus[]; slo: StatusSlo; overall: 'operational' | 'degraded' | 'down' | 'no-data'; checkedAt: string | null }

function percentile(sorted: number[], p: number): number { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1); return sorted[Math.max(0, i)]!; }

async function computeView(page: StatusPage): Promise<StatusView> {
  const { rows } = await pool.query(`SELECT TOP 2000 target_name, ok, status, ms, created_at FROM api_status_checks WHERE page_id=$1 ORDER BY created_at DESC`, [page.id]);
  const byTarget = new Map<string, any[]>();
  for (const r of rows) { const k = r.target_name; if (!byTarget.has(k)) byTarget.set(k, []); byTarget.get(k)!.push(r); }
  const targets: TargetStatus[] = page.targets.map((t) => {
    const checks = byTarget.get(t.name) || [];
    const samples = checks.length;
    const up = checks.filter((c) => c.ok).length;
    const uptimePct = samples ? Math.round((up / samples) * 1000) / 10 : 0;
    const latencies = checks.map((c) => Number(c.ms) || 0).sort((a, b) => a - b);
    const p95Ms = percentile(latencies, 95);
    const avgMs = samples ? Math.round(latencies.reduce((a, b) => a + b, 0) / samples) : 0;
    const last = checks[0];
    const sloMet = samples > 0 && uptimePct >= page.slo.uptimePct && p95Ms <= page.slo.p95Ms;
    return { name: t.name, uptimePct, p95Ms, avgMs, samples, lastOk: !!last?.ok, lastStatus: last?.status ?? null, sloMet };
  });
  const withData = targets.filter((t) => t.samples > 0);
  const overall: StatusView['overall'] = withData.length === 0 ? 'no-data' : withData.every((t) => t.lastOk) ? (withData.every((t) => t.sloMet) ? 'operational' : 'degraded') : withData.some((t) => t.lastOk) ? 'degraded' : 'down';
  return { name: page.name, targets, slo: page.slo, overall, checkedAt: rows[0]?.created_at || null };
}

export async function getStatusView(tenantId: string, id: string): Promise<StatusView | null> {
  const page = await getStatusPage(tenantId, id);
  return page ? computeView(page) : null;
}

/** PUBLIC: the status view + HTML for /status/:token. */
export async function getPublicStatus(token: string): Promise<{ view: StatusView; html: string } | null> {
  if (!/^[0-9a-f]{8,64}$/i.test(token)) return null;
  const { rows } = await pool.query(`SELECT * FROM api_status_pages WHERE token=$1`, [token]);
  if (!rows.length || !rows[0].enabled) return null;
  const page = mapPage(rows[0]);
  const view = await computeView(page);
  return { view, html: renderStatusHtml(view) };
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function renderStatusHtml(v: StatusView): string {
  const color = v.overall === 'operational' ? '#059669' : v.overall === 'degraded' ? '#D97706' : v.overall === 'down' ? '#DC2626' : '#6B7280';
  const label = v.overall === 'operational' ? 'All systems operational' : v.overall === 'degraded' ? 'Degraded performance' : v.overall === 'down' ? 'Major outage' : 'Awaiting data';
  const rows = v.targets.map((t) => { const c = t.samples === 0 ? '#6B7280' : t.lastOk ? (t.sloMet ? '#059669' : '#D97706') : '#DC2626'; const st = t.samples === 0 ? 'no data' : t.lastOk ? (t.sloMet ? 'operational' : 'degraded') : 'down'; return `<tr><td style="padding:12px 8px;font-weight:600">${esc(t.name)}</td><td style="padding:12px 8px;color:${c};font-weight:600">${st}</td><td style="padding:12px 8px;text-align:right;font-variant-numeric:tabular-nums">${t.uptimePct}%</td><td style="padding:12px 8px;text-align:right;font-variant-numeric:tabular-nums">${t.p95Ms}ms</td><td style="padding:12px 8px;text-align:right;color:#9CA3AF;font-variant-numeric:tabular-nums">${t.samples}</td></tr>`; }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(v.name)} — status</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F9FAFB;color:#111827;margin:0;padding:24px}.wrap{max-width:760px;margin:0 auto}.card{background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}h1{font-size:18px;margin:0 0 4px}.badge{display:inline-flex;align-items:center;gap:8px;font-weight:700;color:${color};margin:12px 0 20px}.dot{width:12px;height:12px;border-radius:50%;background:${color}}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:#6B7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:8px;border-bottom:1px solid #E5E7EB}th.r{text-align:right}.foot{color:#9CA3AF;font-size:12px;margin-top:16px}</style></head><body><div class="wrap"><div class="card"><h1>${esc(v.name)}</h1><div class="badge"><span class="dot"></span>${label}</div><table><thead><tr><th>Service</th><th>Status</th><th class="r">Uptime</th><th class="r">p95</th><th class="r">Samples</th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="padding:16px;color:#9CA3AF">No checks recorded yet.</td></tr>'}</tbody></table><div class="foot">SLO: ${v.slo.uptimePct}% uptime · p95 ≤ ${v.slo.p95Ms}ms${v.checkedAt ? ` · last checked ${esc(String(v.checkedAt))}` : ''} · powered by IntelliQE</div></div></div></body></html>`;
}

/* ── In-process poller: refresh enabled pages every few minutes. ── */
let started = false;
export function startApiStatus(intervalMs = 180_000): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      const { rows } = await pool.query(`SELECT * FROM api_status_pages WHERE enabled = 1`, []);
      for (const r of rows.slice(0, 50)) { try { await probeStatusPage(r.tenant_id, mapPage(r)); } catch { /* per-page best effort */ } }
    } catch { /* DB not ready yet */ }
  };
  setInterval(() => void tick(), intervalMs).unref?.();
}
