/**
 * FixWorkflow — one guided "failure → fix" wizard.
 *
 * The studio already ships the individual tools (cluster failures, propose
 * semantic heals, open a remediation PR) as separate modals. This chains them
 * into a single coherent flow so an engineer goes from a pile of red tests to a
 * reviewable changeset without hopping between five panels:
 *
 *   1 Collect → 2 Cluster → 3 Heal → 4 PR (optional)
 *
 * State is carried between steps — the failures collected in step 1 feed the
 * clustering and the heal, and the proposals adopted in step 3 become the
 * markdown changeset the PR carries. Each async step owns its loading + error.
 * Nothing here is destructive on its own: the PR step is opt-in and the token
 * is passed through for the single call only.
 */
import { useState } from 'react';
import { Wrench, GitMerge, Layers, HeartPulse, X, CheckCircle2, AlertTriangle, ArrowRight, ChevronRight } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  clusterApiFailures, proposeHeal, openRemediationPr,
  type FailureClusterReport, type HealResult, type HealProposal, type RemediationResult,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { MethodBadge } from './primitives';
import type { CatalogEndpoint } from './types';

/* The failure shape the three clients accept — all fields optional so a
 * half-filled row or a loosely-typed paste still round-trips. */
interface Failure {
  title?: string;
  method?: string;
  url?: string;
  error?: string;
  expectedStatus?: number;
  headers?: unknown;
  body?: unknown;
}

/* The manual row editor keeps every field a controlled string. */
interface FailureRow { title: string; method: string; url: string; error: string }

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium';

const STEPS: { n: number; label: string; icon: React.ElementType }[] = [
  { n: 1, label: 'Collect', icon: Layers },
  { n: 2, label: 'Cluster', icon: Layers },
  { n: 3, label: 'Heal', icon: HeartPulse },
  { n: 4, label: 'PR', icon: GitMerge },
];

const EXAMPLE: Failure[] = [
  { title: 'List users returns 200', method: 'GET', url: 'https://api.example.com/v1/users', error: 'expected 200 but got 500', expectedStatus: 200 },
  { title: 'Get order by id', method: 'GET', url: 'https://api.example.com/v1/orders/42', error: 'expected 200 but got 404', expectedStatus: 200 },
  { title: 'Create payment', method: 'POST', url: 'https://api.example.com/v1/payments', error: 'TimeoutError: request exceeded 30000ms', expectedStatus: 201 },
];

const blankRow = (): FailureRow => ({ title: '', method: 'GET', url: '', error: '' });

const errMsg = (e: unknown, fallback: string): string => {
  const x = e as { response?: { data?: { error?: string } }; message?: string };
  return x?.response?.data?.error || x?.message || fallback;
};

/** Normalise loosely-typed items into the Failure shape, dropping empty rows. */
function toFailures(items: unknown[]): Failure[] {
  return items
    .map((it): Failure => {
      const o = (it || {}) as Record<string, unknown>;
      const f: Failure = {};
      if (o.title != null) f.title = String(o.title);
      if (o.method != null) f.method = String(o.method);
      if (o.url != null) f.url = String(o.url);
      if (o.error != null) f.error = String(o.error);
      if (o.expectedStatus != null && o.expectedStatus !== '') {
        const n = Number(o.expectedStatus);
        if (Number.isFinite(n)) f.expectedStatus = n;
      }
      if (o.headers != null) f.headers = o.headers;
      if (o.body != null) f.body = o.body;
      return f;
    })
    .filter((f) => (f.url && f.url.trim()) || (f.title && f.title.trim()));
}

/** Tone a classification / confidence with the studio's standard chip colours. */
function toneClass(key: string): string {
  const k = (key || '').toLowerCase();
  if (k === 'regression' || k === 'critical') return 'text-red-700 bg-red-50 border-red-200';
  if (k === 'contract-evolution' || k === 'high') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (k === 'flaky' || k === 'medium') return 'text-amber-700 bg-amber-50 border-amber-200';
  if (k === 'environment' || k === 'auth' || k === 'low') return 'text-blue-700 bg-blue-50 border-blue-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

/** Build the reviewable markdown changeset from the adopted proposals. */
function buildChangesetMarkdown(props: HealProposal[]): string {
  const lines: string[] = [];
  lines.push(`# IntelliQE guided fix — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`${props.length} proposal${props.length === 1 ? '' : 's'} adopted from the guided failure → fix workflow.`);
  lines.push('');
  props.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.title || `${p.method} ${p.url}`}`);
    lines.push('');
    lines.push(`- **Endpoint:** \`${p.method} ${p.url}\``);
    lines.push(`- **Classification:** ${p.classification}`);
    lines.push(`- **Confidence:** ${p.confidence}`);
    if (p.summary) lines.push(`- **Summary:** ${p.summary}`);
    if (p.rationale) lines.push(`- **Rationale:** ${p.rationale}`);
    if (p.patch?.expectedStatus !== undefined) lines.push(`- **Proposed expected status:** ${p.patch.expectedStatus}`);
    lines.push('');
  });
  return lines.join('\n');
}

export default function FixWorkflow({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [step, setStep] = useState(1);

  // Step 1 — collect
  const [mode, setMode] = useState<'json' | 'rows'>('rows');
  const [jsonText, setJsonText] = useState('');
  const [rows, setRows] = useState<FailureRow[]>([blankRow()]);
  const [collectError, setCollectError] = useState('');
  const [failures, setFailures] = useState<Failure[]>([]);

  // Step 2 — cluster
  const [clusterReport, setClusterReport] = useState<FailureClusterReport | null>(null);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [clusterError, setClusterError] = useState('');

  // Step 3 — heal
  const [healResult, setHealResult] = useState<HealResult | null>(null);
  const [healLoading, setHealLoading] = useState(false);
  const [healError, setHealError] = useState('');
  const [adopted, setAdopted] = useState<Record<number, boolean>>({});

  // Step 4 — PR
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github');
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState('');
  const [host, setHost] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [prTitle, setPrTitle] = useState('IntelliQE: guided test fixes');
  const [prResult, setPrResult] = useState<RemediationResult | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [prError, setPrError] = useState('');

  const setRow = (i: number, patch: Partial<FailureRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, blankRow()]);
  const delRow = (i: number) => setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, j) => j !== i)));

  const loadExample = () => { setMode('json'); setJsonText(JSON.stringify(EXAMPLE, null, 2)); setCollectError(''); };

  const collectFailures = (): Failure[] | null => {
    setCollectError('');
    if (mode === 'json') {
      let parsed: unknown;
      try { parsed = JSON.parse(jsonText); }
      catch { setCollectError('Invalid JSON — expected an array of failing tests.'); return null; }
      if (!Array.isArray(parsed)) { setCollectError('JSON must be an array of failing tests.'); return null; }
      const f = toFailures(parsed);
      if (!f.length) { setCollectError('No failures found — each item needs at least a url or a title.'); return null; }
      return f;
    }
    const f = toFailures(rows);
    if (!f.length) { setCollectError('Add at least one failing test with a url or title.'); return null; }
    return f;
  };

  const runCluster = async (f: Failure[]) => {
    setClusterLoading(true); setClusterError(''); setClusterReport(null);
    try { setClusterReport(await clusterApiFailures(f, true)); }
    catch (e) { setClusterError(errMsg(e, 'Clustering failed.')); }
    finally { setClusterLoading(false); }
  };

  const runHeal = async (f: Failure[]) => {
    setHealLoading(true); setHealError(''); setHealResult(null);
    try {
      const res = await proposeHeal({ failures: f });
      setHealResult(res);
      // Pre-select the proposals the orchestrator flagged safe to adopt.
      const next: Record<number, boolean> = {};
      (res?.proposals || []).forEach((p, i) => { if (p?.shouldHeal) next[i] = true; });
      setAdopted(next);
    } catch (e) { setHealError(errMsg(e, 'Could not propose fixes.')); }
    finally { setHealLoading(false); }
  };

  // 1 → 2: parse, reset everything downstream, run the clustering.
  const goCollectToCluster = () => {
    const f = collectFailures();
    if (!f) return;
    setFailures(f);
    setClusterReport(null); setClusterError('');
    setHealResult(null); setHealError(''); setAdopted({});
    setPrResult(null); setPrError('');
    setStep(2);
    void runCluster(f);
  };

  // 2 → 3: run the heal once (kept if the user steps back and forward).
  const goClusterToHeal = () => {
    setStep(3);
    if (!healResult) void runHeal(failures);
  };

  const adoptedProposals = (healResult?.proposals || []).filter((_, i) => adopted[i]);

  const runPr = async () => {
    setPrLoading(true); setPrError(''); setPrResult(null);
    try {
      const files = [{ path: `intelliqe/fix-${Date.now()}.md`, content: buildChangesetMarkdown(adoptedProposals) }];
      setPrResult(await openRemediationPr({
        provider,
        token: token.trim(),
        repo: repo.trim(),
        host: provider === 'gitlab' ? host.trim() || undefined : undefined,
        baseBranch: baseBranch.trim() || undefined,
        title: prTitle.trim() || 'IntelliQE: guided test fixes',
        body: `Opened from the IntelliQE guided failure → fix workflow.\n\n${adoptedProposals.length} proposal${adoptedProposals.length === 1 ? '' : 's'} adopted.`,
        files,
      }));
    } catch (e) { setPrError(errMsg(e, 'Could not open the request.')); }
    finally { setPrLoading(false); }
  };

  const canCollect = mode === 'json' ? jsonText.trim() !== '' : rows.some((r) => r.url.trim() || r.title.trim());
  const canOpenPr = token.trim() !== '' && repo.trim() !== '' && adoptedProposals.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Wrench className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Guided failure → fix workflow</h3>
          <span className="text-[11px] text-gray-400">cluster · heal · PR, one flow</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0 overflow-x-auto">
          {STEPS.map((s, i) => {
            const done = step > s.n;
            const active = step === s.n;
            const Icon = done ? CheckCircle2 : s.icon;
            return (
              <div key={s.n} className="flex items-center gap-1 flex-shrink-0">
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${
                    active ? 'text-white bg-[#7C3AED] border-[#7C3AED]'
                    : done ? 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]'
                    : 'text-gray-400 bg-gray-50 border-gray-200'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="tabular-nums">{s.n}</span> {s.label}
                </span>
                {i < STEPS.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-gray-300" />}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* ── Step 1 — Collect ── */}
          {step === 1 && (
            <>
              {collectError && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
                  <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{collectError}</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-lg border border-[#E4E0F5] overflow-hidden">
                  <button type="button" onClick={() => setMode('rows')} className={`px-3 py-1.5 text-[12px] font-medium ${mode === 'rows' ? 'bg-[#7C3AED] text-white' : 'bg-white text-gray-600 hover:text-[#7C3AED]'}`}>Add rows</button>
                  <button type="button" onClick={() => setMode('json')} className={`px-3 py-1.5 text-[12px] font-medium ${mode === 'json' ? 'bg-[#7C3AED] text-white' : 'bg-white text-gray-600 hover:text-[#7C3AED]'}`}>Paste JSON</button>
                </div>
                <button type="button" onClick={loadExample} className={`${SECONDARY_BTN} ml-auto`}>Load example</button>
              </div>

              {mode === 'json' ? (
                <div>
                  <label className={LABEL}>Failing tests (JSON array)</label>
                  <textarea
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    rows={12}
                    placeholder={'[\n  { "title": "List users", "method": "GET", "url": "https://api.example.com/v1/users", "error": "expected 200 but got 500", "expectedStatus": 200 }\n]'}
                    className={`${INPUT} font-mono text-[11.5px] resize-y`}
                  />
                  <p className="text-[10.5px] text-gray-400 mt-1">Each item accepts <span className="font-mono">title, method, url, error, expectedStatus, headers, body</span>.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className={LABEL}>Failing tests</label>
                  {rows.map((r, i) => (
                    <div key={i} className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-2.5 space-y-2">
                      <div className="flex items-center gap-1.5">
                        <select value={r.method} onChange={(e) => setRow(i, { method: e.target.value })} className={`${FIELD} w-24 flex-shrink-0`}>
                          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <input value={r.url} onChange={(e) => setRow(i, { url: e.target.value })} list="fw-urls" placeholder="https://api.example.com/path" className={INPUT} />
                        <button type="button" onClick={() => delRow(i)} disabled={rows.length <= 1} aria-label="Remove row" className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-30 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
                      </div>
                      <input value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} placeholder="title (optional)" className={INPUT} />
                      <textarea value={r.error} onChange={(e) => setRow(i, { error: e.target.value })} placeholder="error or failed assertion — e.g. expected 200 but got 404" className={`${INPUT} min-h-[44px] resize-y`} />
                    </div>
                  ))}
                  <datalist id="fw-urls">{endpoints.map((e) => <option key={e.id} value={e.url} />)}</datalist>
                  <button type="button" onClick={addRow} className={SECONDARY_BTN}>Add failing test</button>
                </div>
              )}
            </>
          )}

          {/* ── Step 2 — Cluster ── */}
          {step === 2 && (
            <>
              {clusterLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Grouping {failures.length} failure{failures.length === 1 ? '' : 's'} by root cause…</div>
              ) : clusterError ? (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{clusterError}</p></div>
                  <button type="button" onClick={() => void runCluster(failures)} className={SECONDARY_BTN}>Retry clustering</button>
                </div>
              ) : clusterReport ? (
                <div className="space-y-2">
                  <p className="text-[12px] text-gray-500">{clusterReport.summary?.failures ?? failures.length} failure{(clusterReport.summary?.failures ?? failures.length) === 1 ? '' : 's'} → {clusterReport.summary?.clusters ?? clusterReport.clusters?.length ?? 0} root cause{(clusterReport.summary?.clusters ?? 0) === 1 ? '' : 's'}</p>
                  {(clusterReport.clusters || []).map((c, i) => (
                    <div key={c.signature || i} className="rounded-lg border border-gray-100 p-3 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`${CHIP} ${toneClass(c.category)}`}>{c.category || 'other'}</span>
                        <span className="text-[12px] font-mono text-gray-800 flex-1 min-w-0 truncate">{c.label}</span>
                        <span className="text-[11px] font-semibold text-gray-500 tabular-nums">{c.count ?? c.members?.length ?? 0}×</span>
                      </div>
                      {c.sample && (c.sample.method || c.sample.url) && (
                        <div className="flex items-center gap-1.5 min-w-0">
                          {c.sample.method && <MethodBadge method={c.sample.method} />}
                          <span className="text-[11px] font-mono text-gray-500 truncate">{c.sample.title || c.sample.url}</span>
                        </div>
                      )}
                      {c.suggestedFix && <div className="text-[11.5px] text-[#6D28D9] bg-[#F5F3FF] border border-[#E4E0F5] rounded px-2 py-1.5"><span className="font-semibold">Suggested fix:</span> {c.suggestedFix}</div>}
                      {c.sample?.error && <pre className="text-[10.5px] font-mono text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto max-h-24 whitespace-pre-wrap break-words">{c.sample.error}</pre>}
                    </div>
                  ))}
                  {(clusterReport.clusters || []).length === 0 && <p className="text-[12px] text-gray-400">No clusters returned — continue to the heal step.</p>}
                </div>
              ) : null}
            </>
          )}

          {/* ── Step 3 — Heal ── */}
          {step === 3 && (
            <>
              {healLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Proposing intent-aware fixes…</div>
              ) : healError ? (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{healError}</p></div>
                  <button type="button" onClick={() => void runHeal(failures)} className={SECONDARY_BTN}>Retry heal</button>
                </div>
              ) : healResult ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[12px] text-gray-500">{healResult.summary?.analyzed ?? healResult.proposals?.length ?? 0} analyzed · {healResult.summary?.healable ?? 0} healable · {healResult.summary?.regressions ?? 0} regression{(healResult.summary?.regressions ?? 0) === 1 ? '' : 's'}</p>
                    <span className="text-[11px] text-gray-400">{adoptedProposals.length} selected</span>
                  </div>
                  {(healResult.proposals || []).map((p, i) => (
                    <label key={p.endpointId || `${p.url}-${i}`} className={`${CARD} block p-3 space-y-2 cursor-pointer ${adopted[i] ? 'ring-1 ring-[#DDD6FE]' : ''}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <input type="checkbox" checked={!!adopted[i]} onChange={(e) => setAdopted((a) => ({ ...a, [i]: e.target.checked }))} className="rounded border-gray-300 flex-shrink-0" />
                        <MethodBadge method={p.method} />
                        <span className="text-[12px] font-mono text-gray-700 truncate min-w-0 flex-1">{p.title || p.url}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`${CHIP} ${toneClass(p.classification)}`}>{p.classification}</span>
                        <span className={`${CHIP} ${toneClass(p.confidence)}`}>{p.confidence} confidence</span>
                        {p.shouldHeal
                          ? <span className={`${CHIP} text-emerald-700 bg-emerald-50 border-emerald-200`}>Safe to adopt</span>
                          : <span className={`${CHIP} text-gray-600 bg-gray-50 border-gray-200`}>Review only</span>}
                      </div>
                      {p.summary && <p className="text-[12.5px] font-medium text-gray-800">{p.summary}</p>}
                      {p.rationale && <p className="text-[11.5px] text-gray-500">{p.rationale}</p>}
                      {p.observed && (p.observed.status !== undefined || p.observed.reachable === false) && (
                        <p className="text-[11px] text-gray-400">observed {p.observed.status !== undefined ? `status ${p.observed.status}` : ''}{p.observed.reachable === false ? ' · unreachable' : ''}</p>
                      )}
                    </label>
                  ))}
                  {(healResult.proposals || []).length === 0 && <p className="text-[12px] text-gray-400">No proposals returned for these failures.</p>}
                  <p className="text-[10.5px] text-gray-400 italic">Proposals are advisory — selected ones become the PR changeset. Regressions are never auto-healed.</p>
                </div>
              ) : null}
            </>
          )}

          {/* ── Step 4 — PR ── */}
          {step === 4 && (
            <>
              {prError && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{prError}</p></div>
              )}
              <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] px-3 py-2 text-[11.5px] text-gray-600">
                {adoptedProposals.length} proposal{adoptedProposals.length === 1 ? '' : 's'} will be written to <span className="font-mono text-[#6D28D9]">intelliqe/fix-&lt;timestamp&gt;.md</span> as the reviewable changeset.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Provider</label>
                  <select value={provider} onChange={(e) => setProvider(e.target.value as 'github' | 'gitlab')} className={INPUT}>
                    <option value="github">GitHub</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Token</label>
                  <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className={INPUT} />
                  <p className="text-[10px] text-gray-400 mt-1">used once, not stored</p>
                </div>
              </div>
              <div>
                <label className={LABEL}>Repo</label>
                <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" className={INPUT} />
                <p className="text-[10px] text-gray-400 mt-1">github: owner/repo · gitlab: group/project or numeric id</p>
              </div>
              {provider === 'gitlab' && (
                <div>
                  <label className={LABEL}>Host (optional)</label>
                  <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://gitlab.com" className={INPUT} />
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Base branch (optional)</label>
                  <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Title</label>
                  <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} className={INPUT} />
                </div>
              </div>

              {prResult && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span className="text-[12.5px] font-semibold text-emerald-700">{prResult.provider} request opened · {prResult.filesCommitted} file{prResult.filesCommitted === 1 ? '' : 's'} committed</span>
                  </div>
                  {prResult.url && (
                    <a href={prResult.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 truncate text-[11px] font-mono text-[#6D28D9] bg-white border border-[#DDD6FE] rounded px-2 py-1.5 hover:underline max-w-full">
                      <span className="truncate">{prResult.url}</span>
                    </a>
                  )}
                  {prResult.branch && <p className="text-[11px] text-emerald-700">branch: <span className="font-mono">{prResult.branch}</span></p>}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer — navigation */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[#EDE9FE] flex-shrink-0 bg-white">
          {step > 1 && <button type="button" onClick={() => setStep((s) => Math.max(1, s - 1))} className={SECONDARY_BTN}>Back</button>}
          <div className="ml-auto flex items-center gap-2">
            {step === 1 && (
              <button type="button" onClick={goCollectToCluster} disabled={!canCollect} className={PRIMARY_BTN}>Cluster failures<ArrowRight className="w-3.5 h-3.5" /></button>
            )}
            {step === 2 && (
              <button type="button" onClick={goClusterToHeal} disabled={clusterLoading} className={PRIMARY_BTN}>
                {clusterLoading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <HeartPulse className="w-3.5 h-3.5" />}Heal these<ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === 3 && (
              <>
                <button type="button" onClick={onClose} className={SECONDARY_BTN}>Finish</button>
                <button type="button" onClick={() => setStep(4)} disabled={healLoading || adoptedProposals.length === 0} className={PRIMARY_BTN}>Open PR<ArrowRight className="w-3.5 h-3.5" /></button>
              </>
            )}
            {step === 4 && (
              <button type="button" onClick={() => void runPr()} disabled={prLoading || !canOpenPr} className={PRIMARY_BTN}>
                {prLoading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitMerge className="w-3.5 h-3.5" />}{provider === 'gitlab' ? 'Open MR' : 'Open PR'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
