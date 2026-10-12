/**
 * api-llm-eval.service.ts
 * ───────────────────────
 * Dataset-scale LLM evaluation — the Promptfoo / DeepEval / Braintrust slice
 * (distinct from api-llm-testing, which is OWASP-LLM security). A versioned
 * DATASET (many input/expected rows) is run against an AI-backed endpoint and
 * scored by a METRIC SUITE (status, latency, contains, exact, regex, non-empty,
 * and an LLM-judge "semantic match"); results persist per run so pass-rate /
 * score regressions are visible run-over-run.
 *
 * Standalone, opt-in. Live HTTP via the shared helper; the LLM judge reuses the
 * tenant LLM (passed in by the route, like api-semantic). No pipeline coupling.
 */
import { randomUUID } from 'node:crypto';
import pool from '../db.js';
import { fetchFull, buildHeaders, type HttpEndpoint } from '../utils/api-http.js';
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export type MetricId = 'status' | 'non-empty' | 'contains' | 'exact' | 'regex' | 'json-has' | 'latency' | 'semantic';
export interface EvalTarget { method?: string; url: string; headers?: { key: string; value: string }[]; auth?: HttpEndpoint['auth']; bodyTemplate?: string }
export interface EvalRow { input: string; expected?: string; vars?: Record<string, string> }
export interface EvalDataset { id: string; name: string; target: EvalTarget; rows: EvalRow[]; metrics: MetricId[]; latencyMs?: number; createdBy: string; createdAt: string; updatedAt: string }

export interface MetricOutcome { metric: MetricId; passed: boolean; detail: string }
export interface RowResult { input: string; status?: number; latencyMs: number; outputSample: string; metrics: MetricOutcome[]; passed: boolean }
export interface EvalRunSummary {
  datasetId: string; datasetName: string; at: string; rowsRun: number;
  passRate: number; avgLatencyMs: number; perMetric: { metric: MetricId; passRate: number }[];
  score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; rows: RowResult[];
}

const METRIC_CATALOG: { id: MetricId; label: string; needsExpected: boolean }[] = [
  { id: 'status', label: 'HTTP 2xx', needsExpected: false },
  { id: 'non-empty', label: 'Non-empty response', needsExpected: false },
  { id: 'latency', label: 'Latency under threshold', needsExpected: false },
  { id: 'contains', label: 'Contains expected', needsExpected: true },
  { id: 'exact', label: 'Exact match', needsExpected: true },
  { id: 'regex', label: 'Matches regex', needsExpected: true },
  { id: 'json-has', label: 'JSON has field=value', needsExpected: true },
  { id: 'semantic', label: 'Semantic match (LLM judge)', needsExpected: true },
];
export function listEvalMetrics() { return METRIC_CATALOG; }

function mapDataset(r: any): EvalDataset {
  const parse = <T>(s: any, d: T): T => { try { return JSON.parse(s); } catch { return d; } };
  return { id: String(r.id), name: r.name || 'Dataset', target: parse(r.target, { url: '' }), rows: parse(r.data_rows, []), metrics: parse(r.metrics, ['status']), latencyMs: r.latency_ms ?? undefined, createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at };
}

export async function listEvalDatasets(tenantId: string): Promise<EvalDataset[]> {
  const { rows } = await pool.query(`SELECT * FROM api_llm_eval_datasets WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapDataset);
}
export async function getEvalDataset(tenantId: string, id: string): Promise<EvalDataset | null> {
  const { rows } = await pool.query(`SELECT * FROM api_llm_eval_datasets WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? mapDataset(rows[0]) : null;
}
export async function saveEvalDataset(tenantId: string, username: string, input: any): Promise<EvalDataset> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'Eval dataset';
  const target: EvalTarget = { method: String(input?.target?.method || 'POST').toUpperCase(), url: String(input?.target?.url || '').slice(0, 2000), headers: Array.isArray(input?.target?.headers) ? input.target.headers : [], auth: input?.target?.auth, bodyTemplate: typeof input?.target?.bodyTemplate === 'string' ? input.target.bodyTemplate.slice(0, 20000) : '{"input":"{{input}}"}' };
  if (!/^https?:\/\//i.test(target.url)) throw new Error('The dataset target needs an absolute http(s) URL.');
  const rows: EvalRow[] = (Array.isArray(input?.rows) ? input.rows : []).slice(0, 200).map((r: any) => ({ input: String(r?.input ?? '').slice(0, 8000), expected: r?.expected != null ? String(r.expected).slice(0, 8000) : undefined, vars: r?.vars && typeof r.vars === 'object' ? r.vars : undefined }));
  if (!rows.length) throw new Error('Add at least one dataset row.');
  const metrics: MetricId[] = (Array.isArray(input?.metrics) ? input.metrics : ['status', 'non-empty']).filter((m: string) => METRIC_CATALOG.some((x) => x.id === m));
  const latencyMs = Number.isFinite(Number(input?.latencyMs)) ? Math.max(0, Number(input.latencyMs)) : null;

  if (input?.id) {
    const { rowCount } = await pool.query(`UPDATE api_llm_eval_datasets SET name=$3, target=$4, data_rows=$5, metrics=$6, latency_ms=$7, updated_at=SYSUTCDATETIME() WHERE tenant_id=$1 AND id=$2`, [tenantId, String(input.id), name, JSON.stringify(target), JSON.stringify(rows), JSON.stringify(metrics), latencyMs]);
    if (rowCount) { const d = await getEvalDataset(tenantId, String(input.id)); if (d) return d; }
  }
  const { rows: out } = await pool.query(`INSERT INTO api_llm_eval_datasets (tenant_id, name, target, data_rows, metrics, latency_ms, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [tenantId, name, JSON.stringify(target), JSON.stringify(rows), JSON.stringify(metrics), latencyMs, username || '']);
  return mapDataset(out[0]);
}
export async function deleteEvalDataset(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_llm_eval_datasets WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export async function listEvalRuns(tenantId: string, datasetId: string): Promise<{ at: string; passRate: number; score: number; grade: string; rowsRun: number }[]> {
  const { rows } = await pool.query(`SELECT TOP 30 created_at, summary FROM api_llm_eval_runs WHERE tenant_id=$1 AND dataset_id=$2 ORDER BY created_at DESC`, [tenantId, datasetId]);
  return rows.map((r: any) => { let s: any = {}; try { s = JSON.parse(r.summary); } catch { /* */ } return { at: r.created_at, passRate: s.passRate ?? 0, score: s.score ?? 0, grade: s.grade ?? 'F', rowsRun: s.rowsRun ?? 0 }; });
}

function substitute(tpl: string, row: EvalRow): string {
  let out = tpl.replace(/\{\{\s*input\s*\}\}/g, () => jsonEsc(row.input));
  for (const [k, v] of Object.entries(row.vars || {})) out = out.replace(new RegExp(`\\{\\{\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'), () => jsonEsc(v));
  return out;
}
function jsonEsc(s: string): string { return JSON.stringify(String(s)).slice(1, -1); }

async function scoreRow(row: EvalRow, metrics: MetricId[], res: { status?: number; bodyText: string; elapsedMs: number; error?: string }, latencyMs: number | undefined, llm?: LlmConfig): Promise<MetricOutcome[]> {
  const out: MetricOutcome[] = [];
  const body = res.bodyText || '';
  const expected = row.expected || '';
  for (const m of metrics) {
    if (m === 'status') out.push({ metric: m, passed: !res.error && (res.status || 0) >= 200 && (res.status || 0) < 300, detail: res.error || `status ${res.status}` });
    else if (m === 'non-empty') out.push({ metric: m, passed: body.trim().length > 0, detail: `${body.length} chars` });
    else if (m === 'latency') out.push({ metric: m, passed: latencyMs == null ? true : res.elapsedMs <= latencyMs, detail: `${res.elapsedMs}ms${latencyMs != null ? ` / ${latencyMs}ms` : ''}` });
    else if (m === 'contains') out.push({ metric: m, passed: body.toLowerCase().includes(expected.toLowerCase()), detail: expected ? `contains "${expected.slice(0, 30)}"` : 'no expected' });
    else if (m === 'exact') out.push({ metric: m, passed: body.trim() === expected.trim(), detail: 'exact compare' });
    else if (m === 'regex') { let ok = false; try { ok = new RegExp(expected, 'i').test(body); } catch { /* */ } out.push({ metric: m, passed: ok, detail: `/${expected.slice(0, 30)}/` }); }
    else if (m === 'json-has') { const [k, v] = expected.split('='); let ok = false; try { const o = JSON.parse(body); ok = findField(o, (k || '').trim(), (v ?? '').trim()); } catch { /* */ } out.push({ metric: m, passed: ok, detail: `has ${expected.slice(0, 40)}` }); }
    else if (m === 'semantic') { const r = await semanticJudge(row.input, expected, body, llm); out.push({ metric: m, passed: r.passed, detail: r.detail }); }
  }
  return out;
}
function findField(obj: any, key: string, val: string, depth = 0): boolean {
  if (depth > 6 || obj == null) return false;
  if (Array.isArray(obj)) return obj.some((x) => findField(x, key, val, depth + 1));
  if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) { if (k === key && (val === '' || String(v) === val)) return true; if (typeof v === 'object' && findField(v, key, val, depth + 1)) return true; } }
  return false;
}
async function semanticJudge(input: string, expected: string, actual: string, llm?: LlmConfig): Promise<{ passed: boolean; detail: string }> {
  if (!llm) return { passed: false, detail: 'no LLM configured for the judge' };
  try {
    const prompt = `You are grading an AI API response. Input: ${JSON.stringify(input).slice(0, 1500)}\nExpected (intent): ${JSON.stringify(expected).slice(0, 1500)}\nActual response: ${JSON.stringify(actual).slice(0, 2000)}\nReply ONLY JSON: {"pass": boolean, "reason": "short"}`;
    const o = await runLLM(prompt, { maxTokens: 200, llm });
    const p = parseJsonFromResponse<{ pass?: boolean; reason?: string }>(o) || {};
    return { passed: !!p.pass, detail: String(p.reason || '').slice(0, 120) };
  } catch (e) { return { passed: false, detail: `judge error: ${(e as Error).message}` }; }
}

export async function runEval(tenantId: string, username: string, opts: { datasetId?: string; dataset?: any; llm?: LlmConfig }): Promise<EvalRunSummary> {
  const ds = opts.datasetId ? await getEvalDataset(tenantId, opts.datasetId) : (opts.dataset ? await saveEvalDataset(tenantId, username, { ...opts.dataset, id: undefined }) : null);
  if (!ds) throw new Error('Dataset not found. Save a dataset or pass one inline.');
  const target = ds.target;
  const headers = buildHeaders({ method: target.method || 'POST', url: target.url, headers: target.headers, auth: target.auth });
  if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';

  const rowResults: RowResult[] = [];
  for (const row of ds.rows.slice(0, 100)) {
    const body = (target.method || 'POST') === 'GET' ? undefined : substitute(target.bodyTemplate || '{"input":"{{input}}"}', row);
    const url = substitute(target.url, row);
    const res = await fetchFull(url, { method: target.method || 'POST', headers, body }, 20000, 4000);
    const metrics = await scoreRow(row, ds.metrics, res, ds.latencyMs, opts.llm);
    const passed = metrics.length > 0 && metrics.every((m) => m.passed);
    rowResults.push({ input: row.input.slice(0, 120), status: res.status, latencyMs: res.elapsedMs, outputSample: (res.bodyText || res.error || '').slice(0, 200), metrics, passed });
  }

  const rowsRun = rowResults.length;
  const passRate = rowsRun ? Math.round((rowResults.filter((r) => r.passed).length / rowsRun) * 100) : 0;
  const avgLatencyMs = rowsRun ? Math.round(rowResults.reduce((a, r) => a + r.latencyMs, 0) / rowsRun) : 0;
  const perMetric = ds.metrics.map((m) => { const all = rowResults.flatMap((r) => r.metrics).filter((x) => x.metric === m); const pass = all.filter((x) => x.passed).length; return { metric: m, passRate: all.length ? Math.round((pass / all.length) * 100) : 0 }; });
  const score = passRate;
  const grade: EvalRunSummary['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  const summary: EvalRunSummary = { datasetId: ds.id, datasetName: ds.name, at: new Date().toISOString(), rowsRun, passRate, avgLatencyMs, perMetric, score, grade, rows: rowResults };

  await pool.query(`INSERT INTO api_llm_eval_runs (id, tenant_id, dataset_id, model, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), tenantId, ds.id, String(opts.dataset?.model || ''), JSON.stringify({ passRate, score, grade, rowsRun, avgLatencyMs }), username || '']).catch(() => {});
  return summary;
}
