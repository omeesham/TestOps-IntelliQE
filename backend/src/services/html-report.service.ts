/**
 * html-report.service.ts
 * ──────────────────────
 * Builds a custom, BRANDED, fully self-contained HTML execution report for a
 * single test run — the lightweight counterpart to the Allure report. No Java,
 * no Playwright re-run, no external assets: it queries the run's test cases and
 * their REAL execution outcome (automation_scripts.last_run_result) and renders
 * one inline-styled index.html that embeds in an iframe AND downloads as a
 * standalone file. Styling matches the IntelliQE violet/indigo design system.
 *
 * Mirrors allure-report.service.ts in shape (getOrGenerate… + status) so the
 * routes/UI treat the two formats symmetrically.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

/** Root dir where a tenant's generated HTML reports live, keyed by run. */
function reportDir(tenantId: string, runId: string): string {
  return path.join(BACKEND_ROOT, 'html-reports', tenantId, runId);
}

/* ── Design-system palette (kept in sync with CoverageDashboard) ── */
const C = {
  brand: '#3366FF', indigo: '#2645D6', ink: '#1E3A8A', deepInk: '#0F1F4D',
  passed: '#10B981', failed: '#EF4444', notRun: '#9CA3AF',
  panel: '#FFFFFF', soft: '#EEF4FF', line: '#DCE7FF', muted: '#6B7280',
};

/* ── Map a real run outcome to a normalized bucket ── */
function outcome(lastResult: string | null, fallbackStatus: string | null): 'passed' | 'failed' | 'notRun' {
  const r = (lastResult || '').toLowerCase();
  if (r === 'passed') return 'passed';
  if (r === 'failed') return 'failed';
  // Fall back to the lifecycle status only when there is no real run result.
  const s = (fallbackStatus || '').toLowerCase();
  if (s === 'passed') return 'passed';
  if (s === 'failed') return 'failed';
  return 'notRun';
}

/* ── HTML-escape any DB-sourced string before it lands in the template ── */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface CaseRow {
  id: string;
  tc_number: string | null;
  title: string | null;
  type: string | null;
  priority: string | null;
  feature: string | null;
  steps: any;
  status: string | null;
  script_id: string | null;
  last_run_result: string | null;
  last_run_at: string | null;
}

interface RunRow {
  id: string;
  story_key: string | null;
  story_title: string | null;
  source: string | null;
  platform: string | null;
  created_at: string;
}

/** Count steps regardless of whether `steps` is a JSON array, string, or null. */
function stepCount(steps: any): number {
  if (Array.isArray(steps)) return steps.length;
  if (typeof steps === 'string') {
    try { const p = JSON.parse(steps); return Array.isArray(p) ? p.length : 0; } catch { return 0; }
  }
  return 0;
}

/* ── Load the run + its cases (real outcome from automation_scripts) ── */
async function loadRunData(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
): Promise<{ run: RunRow; cases: CaseRow[] }> {
  const runRes = await pool.query(
    `SELECT id, story_key, story_title, source, platform, created_at
       FROM test_runs
      WHERE id = $1${isPlatform ? '' : ' AND tenant_id = $2'}`,
    isPlatform ? [runId] : [runId, tenantId],
  );
  const run = runRes.rows[0];
  if (!run) throw new Error('Run not found for HTML report');

  const caseRes = await pool.query(
    `SELECT tc.id, tc.tc_number, tc.title, tc.type, tc.priority, tc.feature,
            tc.steps, tc.status,
            s.id AS script_id, s.last_run_result, s.last_run_at
       FROM test_cases tc
       LEFT JOIN automation_scripts s
         ON s.test_run_id = tc.test_run_id AND s.test_case_id = tc.id
      WHERE tc.test_run_id = $1
      ORDER BY tc.sort_order`,
    [runId],
  );

  return { run, cases: caseRes.rows };
}

/* ── A horizontal CSS bar row (label · track · count) used for distributions ── */
function distRow(name: string, passed: number, failed: number, notRun: number, max: number): string {
  const total = passed + failed + notRun;
  const pct = (n: number) => (max > 0 ? (n / max) * 100 : 0);
  return `
    <div class="dist-row">
      <span class="dist-label" title="${esc(name)}">${esc(name)}</span>
      <span class="dist-track">
        <span class="seg seg-pass" style="width:${pct(passed)}%"></span>
        <span class="seg seg-fail" style="width:${pct(failed)}%"></span>
        <span class="seg seg-nr" style="width:${pct(notRun)}%"></span>
      </span>
      <span class="dist-count">${total}</span>
    </div>`;
}

/* ── Group cases by an attribute into passed/failed/notRun buckets ── */
function groupBy(cases: CaseRow[], pick: (c: CaseRow) => string) {
  const map = new Map<string, { passed: number; failed: number; notRun: number }>();
  for (const c of cases) {
    const key = (pick(c) || '').trim() || 'Unspecified';
    const b = map.get(key) || { passed: 0, failed: 0, notRun: 0 };
    b[outcome(c.last_run_result, c.status)] += 1;
    map.set(key, b);
  }
  return [...map.entries()]
    .map(([name, b]) => ({ name, ...b, total: b.passed + b.failed + b.notRun }))
    .sort((a, b) => b.total - a.total);
}

const STATUS_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  passed: { bg: '#DCFCE7', fg: '#047857', label: 'Passed' },
  failed: { bg: '#FEE2E2', fg: '#B91C1C', label: 'Failed' },
  notRun: { bg: '#F3F4F6', fg: '#6B7280', label: 'Not run' },
};

/* ── Render the whole self-contained report document ── */
function renderHtml(run: RunRow, cases: CaseRow[], generatedAt: string): string {
  const total = cases.length;
  let passed = 0, failed = 0, notRun = 0, scripted = 0;
  for (const c of cases) {
    if (c.script_id != null) scripted += 1;
    const o = outcome(c.last_run_result, c.status);
    if (o === 'passed') passed += 1; else if (o === 'failed') failed += 1; else notRun += 1;
  }
  const executed = passed + failed;
  const passRate = executed > 0 ? Math.round((passed / executed) * 100) : 0;
  const autoCov = total > 0 ? Math.round((scripted / total) * 100) : 0;

  const byPriority = groupBy(cases, (c) => c.priority || '');
  const byType = groupBy(cases, (c) => c.type || '');
  const byFeature = groupBy(cases, (c) => c.feature || '').slice(0, 10);
  const maxP = Math.max(1, ...byPriority.map((d) => d.total));
  const maxT = Math.max(1, ...byType.map((d) => d.total));
  const maxF = Math.max(1, ...byFeature.map((d) => d.total));

  const title = run.story_title || run.story_key || 'Manual Input';
  const sub = [run.story_key, run.platform ? `Mobile (${run.platform})` : run.source]
    .filter(Boolean).map((s) => esc(String(s))).join(' · ');
  const genStr = new Date(generatedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  // Donut via conic-gradient — pure CSS, no JS/canvas.
  const pSlice = total > 0 ? (passed / total) * 360 : 0;
  const fSlice = total > 0 ? (failed / total) * 360 : 0;
  const donut = `conic-gradient(${C.passed} 0deg ${pSlice}deg, ${C.failed} ${pSlice}deg ${pSlice + fSlice}deg, ${C.notRun} ${pSlice + fSlice}deg 360deg)`;

  const kpi = (label: string, value: string | number, color: string, sub?: string) => `
    <div class="kpi">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value" style="color:${color}">${esc(value)}</div>
      ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}
    </div>`;

  const rows = cases.map((c, i) => {
    const o = outcome(c.last_run_result, c.status);
    const badge = STATUS_BADGE[o];
    const ran = c.last_run_at
      ? new Date(c.last_run_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    return `
      <tr>
        <td class="c-num">${esc(c.tc_number || `TC-${i + 1}`)}</td>
        <td class="c-title">${esc(c.title || 'Untitled test case')}</td>
        <td>${esc(c.feature || '—')}</td>
        <td>${esc(c.type || '—')}</td>
        <td><span class="pri pri-${esc((c.priority || 'p2').toLowerCase())}">${esc(c.priority || 'P2')}</span></td>
        <td class="c-center">${stepCount(c.steps)}</td>
        <td><span class="badge" style="background:${badge.bg};color:${badge.fg}">${badge.label}</span></td>
        <td class="c-muted">${esc(ran)}</td>
      </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IntelliQE Test Report — ${esc(title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    background:#F5F8FF;color:${C.ink};padding:24px;line-height:1.45}
  .wrap{max-width:1080px;margin:0 auto}
  .header{background:linear-gradient(135deg,${C.brand},${C.indigo});border-radius:20px;
    padding:28px 32px;color:#fff;box-shadow:0 10px 30px rgba(38,69,214,.25)}
  .header h1{font-size:22px;font-weight:700;letter-spacing:-.01em}
  .header .sub{opacity:.9;font-size:13px;margin-top:6px}
  .header .gen{opacity:.8;font-size:12px;margin-top:14px}
  .brandtag{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;
    background:rgba(255,255,255,.18);padding:5px 11px;border-radius:999px;margin-bottom:14px}
  .grid-kpi{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-top:18px}
  .kpi{background:${C.panel};border:1px solid ${C.line};border-radius:14px;padding:14px 16px;
    box-shadow:0 1px 2px rgba(30,58,138,.04)}
  .kpi-label{font-size:11px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:.04em}
  .kpi-value{font-size:26px;font-weight:800;margin-top:6px;line-height:1}
  .kpi-sub{font-size:11px;color:${C.muted};margin-top:4px}
  .cols{display:grid;grid-template-columns:300px 1fr;gap:16px;margin-top:16px}
  .card{background:${C.panel};border:1px solid ${C.line};border-radius:16px;padding:18px 20px;
    box-shadow:0 1px 2px rgba(30,58,138,.04)}
  .card h3{font-size:13px;font-weight:700;color:${C.ink};margin-bottom:14px}
  .donut-wrap{display:flex;flex-direction:column;align-items:center;gap:14px}
  .donut{width:160px;height:160px;border-radius:50%;background:${donut};position:relative;
    display:flex;align-items:center;justify-content:center}
  .donut::after{content:'';position:absolute;width:104px;height:104px;background:${C.panel};border-radius:50%}
  .donut .center{position:relative;z-index:1;text-align:center}
  .donut .center .big{font-size:26px;font-weight:800;color:${C.ink};line-height:1}
  .donut .center .lbl{font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
  .legend{display:flex;flex-direction:column;gap:8px;width:100%}
  .legend .li{display:flex;align-items:center;gap:8px;font-size:12px;color:${C.ink}}
  .dot{width:10px;height:10px;border-radius:3px;flex:none}
  .legend .li b{margin-left:auto;font-variant-numeric:tabular-nums}
  .dist-block{margin-bottom:18px}
  .dist-block:last-child{margin-bottom:0}
  .dist-block .t{font-size:12px;font-weight:700;color:${C.ink};margin-bottom:10px}
  .dist-row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
  .dist-label{width:120px;font-size:12px;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dist-track{flex:1;height:14px;background:${C.soft};border-radius:7px;overflow:hidden;display:flex}
  .seg{height:100%}
  .seg-pass{background:${C.passed}} .seg-fail{background:${C.failed}} .seg-nr{background:${C.notRun}}
  .dist-count{width:34px;text-align:right;font-size:12px;font-weight:600;color:${C.muted};font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  thead th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:${C.muted};
    font-weight:700;padding:8px 10px;border-bottom:1px solid ${C.line}}
  tbody td{padding:10px;font-size:12.5px;color:${C.ink};border-bottom:1px solid ${C.soft};vertical-align:top}
  tbody tr:hover{background:#F8FAFF}
  .c-num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:${C.indigo};white-space:nowrap}
  .c-title{font-weight:600;max-width:340px}
  .c-center{text-align:center}
  .c-muted{color:${C.muted};white-space:nowrap;font-size:11px}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
  .pri{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700}
  .pri-p0,.pri-p1{background:#FEE2E2;color:#B91C1C}
  .pri-p2{background:#FEF3C7;color:#92400E}
  .pri-p3,.pri-p4{background:#E0E7FF;color:#3730A3}
  .footer{text-align:center;font-size:11px;color:${C.muted};margin-top:22px}
  @media (max-width:760px){.grid-kpi{grid-template-columns:repeat(2,1fr)}.cols{grid-template-columns:1fr}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <span class="brandtag">⬡ IntelliQE · Execution Report</span>
      <h1>${esc(title)}</h1>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
      <div class="gen">Generated ${esc(genStr)}</div>
      <div class="grid-kpi">
        ${kpi('Total', total, '#fff')}
        ${kpi('Passed', passed, '#D1FAE5')}
        ${kpi('Failed', failed, '#FECACA')}
        ${kpi('Not run', notRun, '#E5E7EB')}
        ${kpi('Pass rate', `${passRate}%`, '#fff', `${executed} executed`)}
        ${kpi('Automation', `${autoCov}%`, '#fff', `${scripted}/${total} scripted`)}
      </div>
    </div>

    <div class="cols">
      <div class="card">
        <h3>Outcome distribution</h3>
        <div class="donut-wrap">
          <div class="donut"><div class="center"><div class="big">${passRate}%</div><div class="lbl">Pass rate</div></div></div>
          <div class="legend">
            <div class="li"><span class="dot" style="background:${C.passed}"></span>Passed <b>${passed}</b></div>
            <div class="li"><span class="dot" style="background:${C.failed}"></span>Failed <b>${failed}</b></div>
            <div class="li"><span class="dot" style="background:${C.notRun}"></span>Not run <b>${notRun}</b></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="dist-block">
          <div class="t">Coverage by priority</div>
          ${byPriority.map((d) => distRow(d.name, d.passed, d.failed, d.notRun, maxP)).join('') || '<div class="dist-count">No data</div>'}
        </div>
        <div class="dist-block">
          <div class="t">Coverage by type</div>
          ${byType.map((d) => distRow(d.name, d.passed, d.failed, d.notRun, maxT)).join('') || '<div class="dist-count">No data</div>'}
        </div>
        <div class="dist-block">
          <div class="t">Top features</div>
          ${byFeature.map((d) => distRow(d.name, d.passed, d.failed, d.notRun, maxF)).join('') || '<div class="dist-count">No data</div>'}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Test cases (${total})</h3>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Title</th><th>Feature</th><th>Type</th><th>Priority</th>
            <th style="text-align:center">Steps</th><th>Result</th><th>Last run</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#6B7280;padding:20px">No test cases for this run.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="footer">Built by JBSIntelliQE — AI-powered QA automation · ${esc(genStr)}</div>
  </div>
</body>
</html>`;
}

/**
 * Build (or rebuild) the branded HTML report for a run and persist it to
 * html-reports/{tenant}/{run}/index.html. Returns the generation timestamp.
 */
export async function getOrGenerateHtmlReport(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
): Promise<{ outputDir: string; generatedAt: string }> {
  if (!runId) throw new Error('runId is required');
  const { run, cases } = await loadRunData(tenantId, isPlatform, runId);

  const outputDir = reportDir(tenantId, runId);
  await fs.mkdir(outputDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const html = renderHtml(run, cases, generatedAt);
  await fs.writeFile(path.join(outputDir, 'index.html'), html, 'utf-8');
  await fs.writeFile(
    path.join(outputDir, 'report-meta.json'),
    JSON.stringify({ generatedAt, runId, tenantId, format: 'html', cases: cases.length }, null, 2),
  );
  return { outputDir, generatedAt };
}

/** Check whether an HTML report already exists for a run. */
export async function getHtmlReportStatus(
  tenantId: string,
  runId?: string,
): Promise<{ exists: boolean; generatedAt?: string; reportUrl?: string }> {
  if (!runId) return { exists: false };
  const metaPath = path.join(reportDir(tenantId, runId), 'report-meta.json');
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    return {
      exists: true,
      generatedAt: meta.generatedAt,
      reportUrl: `/api/html-report/report/${tenantId}/${runId}/index.html`,
    };
  } catch {
    return { exists: false };
  }
}
