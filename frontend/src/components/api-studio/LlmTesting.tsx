/**
 * LlmTesting — AI/LLM & MCP-era testing.
 *
 * Three opt-in tools for AI-powered and agentic APIs:
 *   • Eval      — score an LLM-backed response against a plain-English rubric
 *                 (weighted, per-criterion) with a regression baseline.
 *   • LLM sec   — OWASP LLM Top-10 probing (prompt injection, jailbreak, leak).
 *   • MCP sec   — enumerate an MCP server's tools and flag tool-poisoning,
 *                 over-broad capability, and missing authentication.
 * Standalone — live-probes the target and never touches the pipeline.
 */
import { useState } from 'react';
import { X, Sparkles, ShieldAlert, Boxes, Plus, Trash2, AlertTriangle, CheckCircle2, TrendingDown } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  runApiLlmEval, runApiLlmSecurityScan, runApiMcpSecurityScan,
  type LlmEvalResult, type LlmSecurityReport, type McpSecurityReport, type LlmSecurityFinding, type LlmEvalCriterionInput,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

type Tab = 'eval' | 'security' | 'mcp';
type CriterionRow = { name: string; description: string; weight: string };
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

export default function LlmTesting({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('eval');
  const target = endpoints[0];
  const payload = target ? { id: target.id, title: target.title, method: target.method, url: target.url, headers: target.headers, auth: target.auth, body: target.body } : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Sparkles className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">AI / LLM &amp; MCP testing</h3>
          <div className="ml-auto flex items-center gap-1">
            <TabBtn active={tab === 'eval'} onClick={() => setTab('eval')} icon={Sparkles} label="Quality eval" />
            <TabBtn active={tab === 'security'} onClick={() => setTab('security')} icon={ShieldAlert} label="LLM security" />
            <TabBtn active={tab === 'mcp'} onClick={() => setTab('mcp')} icon={Boxes} label="MCP security" />
            <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {tab === 'eval' && <EvalTab payload={payload} target={target} />}
          {tab === 'security' && <SecurityTab payload={payload} target={target} />}
          {tab === 'mcp' && <McpTab />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ElementType; label: string }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11.5px] font-semibold ${active ? 'text-white bg-gradient-to-r from-[#7C3AED] to-[#6366F1]' : 'text-gray-500 hover:text-[#7C3AED] hover:bg-[#F5F3FF]'}`}>
      <Icon className="w-3.5 h-3.5" />{label}
    </button>
  );
}

function NoTarget() {
  return <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center"><AlertTriangle className="w-7 h-7 text-gray-300" /><p className="text-[12.5px] text-gray-500 max-w-sm">Select an endpoint in the catalogue first — this tool probes the first selected endpoint.</p></div>;
}

/* ── Quality eval ── */
function EvalTab({ payload, target }: { payload: any; target?: CatalogEndpoint }) {
  const [criteria, setCriteria] = useState<CriterionRow[]>([{ name: 'Relevance', description: 'The answer directly addresses the request.', weight: '1' }]);
  const [saveBaseline, setSaveBaseline] = useState(false);
  const [result, setResult] = useState<LlmEvalResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const setRow = (i: number, patch: Partial<CriterionRow>) => setCriteria((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const run = async () => {
    if (!payload) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const crit: LlmEvalCriterionInput[] = criteria.filter((c) => c.name.trim() || c.description.trim()).map((c) => ({ name: c.name.trim() || c.description.slice(0, 30), description: c.description.trim() || c.name, weight: Number(c.weight) || 1 }));
      setResult(await runApiLlmEval(payload, crit, { saveBaseline }));
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Eval failed.'); } finally { setLoading(false); }
  };

  if (!target) return <NoTarget />;
  return (
    <div className="p-4 space-y-3">
      <TargetBar target={target} />
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className={LABEL + ' mb-0'}>Evaluation rubric</span>
          <button type="button" onClick={() => setCriteria((r) => [...r, { name: '', description: '', weight: '1' }])} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3.5 h-3.5" />Add criterion</button>
        </div>
        <div className="space-y-1.5">
          {criteria.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input value={c.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="name" className={`${FIELD} w-32 flex-shrink-0`} />
              <input value={c.description} onChange={(e) => setRow(i, { description: e.target.value })} placeholder="what a good answer should do" className={INPUT} />
              <input value={c.weight} onChange={(e) => setRow(i, { weight: e.target.value })} className={`${FIELD} w-14 flex-shrink-0`} title="weight" />
              <button type="button" onClick={() => setCriteria((r) => r.filter((_, j) => j !== i))} disabled={criteria.length <= 1} className="p-1 rounded text-gray-300 hover:text-red-500 disabled:opacity-30 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer"><input type="checkbox" checked={saveBaseline} onChange={(e) => setSaveBaseline(e.target.checked)} className="rounded border-gray-300" />Save this score as the regression baseline</label>
        <button type="button" onClick={() => void run()} disabled={loading} className={PRIMARY_BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}Evaluate</button>
      </div>
      {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}
      {result && (
        <div className="space-y-2 pt-1">
          <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${result.passed ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
            <span className={`text-[22px] font-bold tabular-nums ${result.passed ? 'text-emerald-700' : 'text-red-700'}`}>{result.score}</span>
            <div className="min-w-0">
              <p className={`text-[12.5px] font-semibold ${result.passed ? 'text-emerald-800' : 'text-red-800'}`}>{result.passed ? 'Passed' : 'Below threshold'} (≥ {result.passThreshold})</p>
              <p className="text-[11px] text-gray-500">HTTP {result.observed.status ?? '—'} · {Math.round(result.observed.elapsedMs)}ms{result.savedBaseline ? ' · baseline saved' : ''}</p>
            </div>
            {result.regression && <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 bg-red-100 border border-red-200 rounded px-2 py-1"><TrendingDown className="w-3.5 h-3.5" />Regression vs {result.baseline?.score}</span>}
            {!result.regression && result.baseline && <span className="ml-auto text-[11px] text-gray-400">baseline {result.baseline.score}</span>}
          </div>
          <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
            {result.perCriterion.map((c, i) => (
              <div key={i} className="px-3 py-2 flex items-start gap-2">
                <span className={`text-[11px] font-bold tabular-nums flex-shrink-0 w-9 ${c.passed ? 'text-emerald-600' : 'text-red-600'}`}>{c.score}/{c.max}</span>
                <div className="min-w-0">
                  <p className="text-[11.5px] font-medium text-gray-800">{c.name}</p>
                  <p className="text-[11px] text-gray-500">{c.rationale}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── LLM security ── */
function SecurityTab({ payload, target }: { payload: any; target?: CatalogEndpoint }) {
  const [field, setField] = useState('');
  const [report, setReport] = useState<LlmSecurityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    if (!payload) return;
    setLoading(true); setError(''); setReport(null);
    try { setReport(await runApiLlmSecurityScan(payload, field.trim() || undefined)); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Scan failed.'); } finally { setLoading(false); }
  };

  if (!target) return <NoTarget />;
  const vulnerable = (report?.findings || []).filter((f) => f.status === 'vulnerable').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const clean = (report?.findings || []).filter((f) => f.status !== 'vulnerable');
  return (
    <div className="p-4 space-y-3">
      <TargetBar target={target} />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className={LABEL}>Injection target field (optional)</label>
          <input value={field} onChange={(e) => setField(e.target.value)} placeholder="e.g. prompt / message / q — leave blank to auto-detect" className={INPUT} />
        </div>
        <button type="button" onClick={() => void run()} disabled={loading} className={PRIMARY_BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}Scan</button>
      </div>
      {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}
      {report && (
        <div className="pt-1">
          {vulnerable.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />No injected instruction was obeyed across {report.summary.probes} probes. Target field: {report.observedField}.</div>
          ) : (
            <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">{vulnerable.map((f, i) => <SecFinding key={i} f={f} />)}</div>
          )}
          {clean.length > 0 && (
            <details className="mt-2"><summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-[#7C3AED]">{clean.length} passed check{clean.length === 1 ? '' : 's'}</summary><div className="mt-2 divide-y divide-gray-50 border border-gray-100 rounded-lg overflow-hidden">{clean.map((f, i) => <SecFinding key={i} f={f} muted />)}</div></details>
          )}
        </div>
      )}
    </div>
  );
}

/* ── MCP security ── */
function McpTab() {
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [report, setReport] = useState<McpSecurityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try { setReport(await runApiMcpSecurityScan(serverUrl.trim(), token.trim() || undefined)); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'MCP scan failed.'); } finally { setLoading(false); }
  };

  const vulnerable = (report?.findings || []).filter((f) => f.status === 'vulnerable').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const clean = (report?.findings || []).filter((f) => f.status !== 'vulnerable');
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className={LABEL}>MCP server URL</label>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className={INPUT} />
        </div>
        <div className="w-48">
          <label className={LABEL}>Bearer token (optional)</label>
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="leave blank to test unauth" className={INPUT} />
        </div>
        <button type="button" onClick={() => void run()} disabled={loading || !serverUrl.trim()} className={PRIMARY_BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Boxes className="w-3.5 h-3.5" />}Scan</button>
      </div>
      {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}
      {report && (
        <div className="space-y-2 pt-1">
          <p className="text-[11px] text-gray-500">{report.summary.tools} tool{report.summary.tools === 1 ? '' : 's'} enumerated · {report.summary.vulnerable} finding{report.summary.vulnerable === 1 ? '' : 's'}</p>
          {vulnerable.length > 0 && <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">{vulnerable.map((f, i) => <SecFinding key={i} f={f} />)}</div>}
          {vulnerable.length === 0 && <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />No tool-poisoning or auth issues flagged.</div>}
          {report.tools.length > 0 && (
            <details><summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-[#7C3AED]">{report.tools.length} tool{report.tools.length === 1 ? '' : 's'} + {clean.length} passed check{clean.length === 1 ? '' : 's'}</summary>
              <div className="mt-2 space-y-1">{report.tools.map((t, i) => <div key={i} className="px-3 py-1.5 border border-gray-100 rounded-lg"><p className="text-[11.5px] font-mono font-semibold text-gray-800">{t.name}</p><p className="text-[11px] text-gray-500 line-clamp-2">{t.description || '(no description)'}</p></div>)}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function TargetBar({ target }: { target: CatalogEndpoint }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50/60 border border-gray-100 rounded-lg">
      <MethodBadge method={target.method} />
      <span className="text-[12px] text-gray-700 min-w-0 flex-1 truncate" title={target.url}>{target.title || target.url}</span>
      <span className="text-[10px] text-gray-400 flex-shrink-0">target</span>
    </div>
  );
}

function SecFinding({ f, muted = false }: { f: LlmSecurityFinding; muted?: boolean }) {
  const sev = {
    high: 'text-red-700 bg-red-50 border-red-200', medium: 'text-amber-700 bg-amber-50 border-amber-200',
    low: 'text-gray-600 bg-gray-100 border-gray-300', info: 'text-blue-700 bg-blue-50 border-blue-200',
  }[f.severity];
  return (
    <div className={`px-3 py-2 ${muted ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${sev}`}>{f.severity}</span>
        <span className="text-[10px] font-mono text-gray-500 flex-shrink-0">{f.category}</span>
        <span className="text-[11.5px] text-gray-700 min-w-0 flex-1 truncate">{f.title}</span>
        {f.status === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
      </div>
      <p className="mt-0.5 ml-1 text-[11px] text-gray-600 leading-relaxed">{f.detail}</p>
    </div>
  );
}
