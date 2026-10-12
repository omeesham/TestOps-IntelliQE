/**
 * RunsView — the live run (when one is in flight) and the history.
 *
 * Live rows come from the run hook; history comes from the server and joins
 * each saved run with its execution report so the outcome per scenario is
 * visible without opening Allure.
 *
 * The run detail reads like the market-best report dashboards: one hero
 * pass-rate ring, compact counters, then a table you can actually work —
 * filter by outcome or layer, search, and open any case to see what it sent
 * and why it failed. All of it is client-side over data the run already has;
 * nothing new is fetched and no run logic changes.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronDown, ChevronRight, ExternalLink, RefreshCw, Activity, AlertTriangle, ListChecks, CheckCircle2, XCircle, MinusCircle, Clock, Search } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { listApiRuns, getApiRun } from '@/services/api';
import { StatusPill, MethodBadge, CategoryChip, PriorityChip, EmptyState, PassRing, FilterChip, DurationBar } from '../primitives';
import { CARD, CARD_HOVER, SECONDARY_BTN, MUTED_CHIP, STRIP, THEAD, TILE_ACTIVE, FIELD, categoryMeta, relativeTime, formatDuration } from '../format';
import type { ApiRun } from '../hooks/useApiRun';
import type { ApiRunSummary, ApiRunDetail } from '../types';

import Loader from '@/components/feedback/Loader';

/** Whether the run-history card is expanded — a UI preference, kept across sessions. */
const HISTORY_OPEN_KEY = 'intelliqe_api_history_open';

interface Props { run: ApiRun; openRunId: string | null; onOpenRun: (id: string | null) => void; onShowReport: () => void }

export default function RunsView({ run, openRunId, onOpenRun, onShowReport }: Props) {
  if (openRunId) return <RunDetail runId={openRunId} onBack={() => onOpenRun(null)} />;
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-6 py-5 space-y-4">
        {run.started && <LiveRun run={run} onShowReport={onShowReport} />}
        <History onOpen={onOpenRun} refreshKey={run.phase === 'report' ? run.testRunId : ''} />
      </div>
    </div>
  );
}

function LiveRun({ run, onShowReport }: { run: ApiRun; onShowReport: () => void }) {
  const passed = run.rows.filter((r) => r.status === 'passed').length;
  const failed = run.rows.filter((r) => r.status === 'failed').length;
  const total = run.rows.length;
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className={`flex items-center gap-2 px-4 h-11 min-w-0 border-b border-[#EDE9FE] ${STRIP}`}>
        {run.running ? <Spinner className="w-4 h-4 text-[#7C3AED] animate-spin" /> : <Activity className="w-4 h-4 text-[#7C3AED]" />}
        <h3 className="text-[12.5px] font-semibold text-gray-900">Current run</h3>
        <span className="text-[11px] text-gray-500 truncate min-w-0">{run.runLabel}</span>
        {total > 0 && <span className="ml-auto flex-shrink-0 font-mono text-[11px] tabular-nums"><span className="text-emerald-600">{passed} ✓</span> · <span className="text-red-600">{failed} ✗</span> · {total}</span>}
        {run.phase === 'report' && <button type="button" onClick={onShowReport} className={SECONDARY_BTN}>Open report</button>}
      </div>
      {run.rows.length === 0 ? (
        <p className="px-4 py-6 text-[11.5px] text-gray-400 text-center">{run.phase === 'review' ? 'Scenarios are designed — run the suite from the Scenarios page.' : run.phase === 'generating' ? 'Designing scenarios…' : 'Nothing has executed yet.'}</p>
      ) : (
        <table className="w-full text-[12px]">
          <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="text-left px-4 py-1.5 font-semibold w-[90px]">Case</th><th className="text-left px-2 py-1.5 font-semibold">Scenario</th><th className="text-left px-2 py-1.5 font-semibold w-[110px]">Status</th><th className="text-right px-4 py-1.5 font-semibold w-[90px]">Time</th></tr></thead>
          <tbody>
            {run.rows.map((r) => (
              <tr key={r.testCaseId} className="border-t border-gray-50 align-top">
                <td className="px-4 py-1.5 font-mono text-[11px] text-gray-500">{r.testCaseId}</td>
                <td className="px-2 py-1.5">
                  <p className="text-gray-800">{r.name}</p>
                  {r.error && <p className="mt-0.5 text-[11px] text-red-600 font-mono whitespace-pre-wrap break-words">{r.error}</p>}
                </td>
                <td className="px-2 py-1.5"><StatusPill status={r.status} /></td>
                <td className="px-4 py-1.5 text-right font-mono text-[11px] text-gray-500 tabular-nums">{r.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── Run history ─────────────────────────────────────────────────────────── */

/** Which outcome bucket a saved run falls in, from its pass rate. */
type HistBucket = 'all' | 'passing' | 'failing' | 'not_run';
function histBucket(r: ApiRunSummary): Exclude<HistBucket, 'all'> {
  if (!r.stats) return 'not_run';
  return r.stats.passRate >= 90 ? 'passing' : 'failing';
}

function History({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey: string }) {
  const [items, setItems] = useState<ApiRunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bucket, setBucket] = useState<HistBucket>('all');
  const [q, setQ] = useState('');
  const pageSize = 20;

  const load = async (p = page) => {
    setLoading(true); setError('');
    try { const res = await listApiRuns(p, pageSize); setItems(res.items); setTotal(res.total); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Could not load runs.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(page); }, [page, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Collapsed or not is a preference, so it survives reloads like the other
     UI preferences do (localStorage, not the per-session catalogue). The
     header — and its run count — stays visible either way. */
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(HISTORY_OPEN_KEY) !== '0'; } catch { return true; }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(HISTORY_OPEN_KEY, next ? '1' : '0'); } catch { /* preference only */ }
  };

  /* Filter + search are over the page already loaded — they narrow what's on
     screen, not what the server returns, so paging still walks the full set. */
  const counts = useMemo(() => {
    const c = { all: items.length, passing: 0, failing: 0, not_run: 0 };
    for (const r of items) c[histBucket(r)]++;
    return c;
  }, [items]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((r) => {
      if (bucket !== 'all' && histBucket(r) !== bucket) return false;
      if (!needle) return true;
      return r.title.toLowerCase().includes(needle) || r.runId.toLowerCase().includes(needle) || (r.createdBy || '').toLowerCase().includes(needle);
    });
  }, [items, bucket, q]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className={`flex items-center gap-2 px-4 h-11 ${open ? 'border-b border-[#EDE9FE]' : ''} ${STRIP}`}>
        <button type="button" onClick={toggle} aria-expanded={open} title={open ? 'Hide the run history' : 'Show the run history'} className="flex items-center gap-1.5 -ml-1 px-1 rounded text-left hover:text-[#7C3AED] transition-colors group">
          <ChevronDown className={`w-3.5 h-3.5 text-gray-400 group-hover:text-[#7C3AED] transition-transform ${open ? '' : '-rotate-90'}`} />
          <h3 className="text-[12.5px] font-semibold text-gray-900 group-hover:text-[#7C3AED]">Run history</h3>
        </button>
        <span className="text-[11px] text-gray-400 tabular-nums">{total} runs</span>
        <button type="button" onClick={toggle} className="ml-auto text-[11px] font-medium text-gray-400 hover:text-[#7C3AED] transition-colors">{open ? 'Hide' : 'Show'}</button>
        {open && <button type="button" onClick={() => load()} className="p-1 text-gray-300 hover:text-[#7C3AED]" title="Refresh"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>}
      </div>
      {!open ? null : <>
      {/* Filter + search over the loaded page */}
      {items.length > 0 && (
        <div className={`flex items-center gap-1.5 flex-wrap px-4 py-2 border-b border-gray-100 ${STRIP}`}>
          <FilterChip active={bucket === 'all'} onClick={() => setBucket('all')} count={counts.all}>All</FilterChip>
          <FilterChip active={bucket === 'passing'} onClick={() => setBucket('passing')} count={counts.passing}>Passing</FilterChip>
          <FilterChip active={bucket === 'failing'} onClick={() => setBucket('failing')} count={counts.failing} tone="danger">Failing</FilterChip>
          {counts.not_run > 0 && <FilterChip active={bucket === 'not_run'} onClick={() => setBucket('not_run')} count={counts.not_run}>Not run</FilterChip>}
          <div className="relative ml-auto">
            <Search className="w-3 h-3 text-gray-300 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search runs…" className={`${FIELD} w-48 pl-6 py-1`} />
          </div>
        </div>
      )}
      {error && <p className="px-4 py-2 text-[11.5px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
      {!loading && items.length === 0 && !error ? (
        <EmptyState icon={Activity} title="No API runs yet" hint="Runs land here once a suite has been executed — from this workspace, the CLI or the public API." />
      ) : (
        <table className="w-full text-[12px]">
          <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="text-left px-4 py-1.5 font-semibold">Run</th><th className="text-left px-2 py-1.5 font-semibold w-[110px]">Source</th><th className="text-right px-2 py-1.5 font-semibold w-[90px]">Scenarios</th><th className="text-left px-2 py-1.5 font-semibold w-[200px]">Result</th><th className="text-right px-2 py-1.5 font-semibold w-[80px]">Time</th><th className="text-right px-4 py-1.5 font-semibold w-[110px]">When</th></tr></thead>
          <tbody>
            {visible.map((r) => {
              const rate = r.stats?.passRate;
              const stripe = rate == null ? '' : rate >= 90 ? 'hover:shadow-[inset_3px_0_0_0_#C4B5FD]' : rate >= 70 ? 'shadow-[inset_3px_0_0_0_#FCD34D]' : 'shadow-[inset_3px_0_0_0_#FCA5A5]';
              return (
              <tr key={r.runId} onClick={() => onOpen(r.runId)} className={`border-t border-gray-50 hover:bg-[#FAFAFE] transition-[background,box-shadow] cursor-pointer ${stripe || 'hover:shadow-[inset_3px_0_0_0_#C4B5FD]'}`}>
                <td className="px-4 py-2"><p className="text-gray-800 truncate max-w-[420px]">{r.title}</p><p className="text-[10.5px] text-gray-400 font-mono">{r.runId} · {r.createdBy}</p></td>
                <td className="px-2 py-2"><span className={`inline-flex px-1.5 py-0.5 rounded border text-[10px] ${MUTED_CHIP}`}>{r.source || 'api'}</span></td>
                <td className="px-2 py-2 text-right font-mono tabular-nums text-gray-700">{r.caseCount}</td>
                <td className="px-2 py-2">
                  {r.stats ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden flex shadow-[inset_0_1px_2px_rgba(30,27,75,0.15)]"><span className="bg-emerald-500" style={{ width: `${r.stats.total ? (r.stats.passed / r.stats.total) * 100 : 0}%` }} /><span className="bg-red-500" style={{ width: `${r.stats.total ? ((r.stats.failed + r.stats.broken) / r.stats.total) * 100 : 0}%` }} /></div>
                      <span className={`font-mono text-[11px] font-semibold tabular-nums w-10 text-right ${r.stats.passRate >= 90 ? 'text-emerald-600' : r.stats.passRate >= 70 ? 'text-amber-600' : 'text-red-600'}`}>{r.stats.passRate}%</span>
                    </div>
                  ) : <StatusPill status="not_run" />}
                </td>
                <td className="px-2 py-2 text-right font-mono text-[11px] text-gray-500 tabular-nums">{r.stats ? formatDuration(r.stats.durationMs) : '—'}</td>
                <td className="px-4 py-2 text-right text-[11px] text-gray-400">{relativeTime(r.createdAt)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!loading && items.length > 0 && visible.length === 0 && (
        <p className="px-4 py-8 text-center text-[12px] text-gray-400">No runs on this page match that filter.</p>
      )}
      {pages > 1 && (
        <div className={`flex items-center gap-2 px-4 h-10 border-t border-[#EDE9FE] text-[11px] text-gray-500 ${STRIP}`}>
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={SECONDARY_BTN}>Previous</button>
          <span className="tabular-nums">Page {page} of {pages}</span>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className={SECONDARY_BTN}>Next</button>
        </div>
      )}
      </>}
    </div>
  );
}

/* ── Run detail ──────────────────────────────────────────────────────────── */

type CaseRow = ApiRunDetail['cases'][number];

/** Fold the raw status onto the three outcomes the table shows. */
function normStatus(s: string): 'passed' | 'failed' | 'not_run' {
  if (s === 'passed') return 'passed';
  if (s === 'failed' || s === 'broken') return 'failed';
  return 'not_run';
}

type DetailBucket = 'all' | 'passed' | 'failed' | 'not_run';

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [state, setState] = useState<{ runId: string; detail: ApiRunDetail | null; error: string }>({ runId, detail: null, error: '' });
  const [bucket, setBucket] = useState<DetailBucket>('all');
  const [layer, setLayer] = useState<string>('all');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getApiRun(runId)
      .then((d) => { if (alive) setState({ runId, detail: d, error: '' }); })
      .catch((err) => { if (alive) setState({ runId, detail: null, error: err?.response?.data?.error || err?.message || 'Could not load the run.' }); });
    return () => { alive = false; };
  }, [runId]);
  // A stale detail (from the previous runId) is never shown while the new one loads.
  const detail = state.runId === runId ? state.detail : null;
  const error = state.runId === runId ? state.error : '';

  const cases = detail?.cases || [];
  const maxMs = useMemo(() => cases.reduce((m, c) => Math.max(m, c.durationMs || 0), 0), [cases]);
  const statusCounts = useMemo(() => {
    const c = { all: cases.length, passed: 0, failed: 0, not_run: 0 };
    for (const k of cases) c[normStatus(k.status)]++;
    return c;
  }, [cases]);
  const layers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const k of cases) {
      const key = (k.type || 'other').toLowerCase();
      if (!seen.has(key)) seen.set(key, categoryMeta(key).label);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [cases]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cases.filter((c) => {
      if (bucket !== 'all' && normStatus(c.status) !== bucket) return false;
      if (layer !== 'all' && (c.type || 'other').toLowerCase() !== layer) return false;
      if (!needle) return true;
      return c.title.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle) || (c.api?.endpoint || '').toLowerCase().includes(needle);
    });
  }, [cases, bucket, layer, q]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-6 py-5 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <button type="button" onClick={onBack} className={SECONDARY_BTN}><ChevronLeft className="w-3.5 h-3.5" />All runs</button>
          <span className={`w-11 h-11 rounded-xl flex items-center justify-center ${TILE_ACTIVE}`}><ListChecks className="w-5 h-5 text-white" /></span>
          {detail && (
            <>
              <div className="min-w-0">
                <h2 className="text-[17px] font-bold text-gray-900 leading-tight truncate">{detail.title}</h2>
                <p className="text-[12.5px] text-gray-500 mt-0.5 font-mono truncate">{detail.runId} · {detail.createdBy} · {relativeTime(detail.createdAt)}</p>
              </div>
              {detail.reportUrl && <a href={detail.reportUrl} target="_blank" rel="noreferrer" className={`ml-auto ${SECONDARY_BTN}`}><ExternalLink className="w-3.5 h-3.5" />{detail.hasAllure ? 'Allure report' : 'Report'}</a>}
            </>
          )}
        </div>
        {error && <p className="text-[12px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />{error}</p>}
        {!detail && !error && <Loader.Block label="Loading run" />}
        {detail && (
          <>
            {detail.stats && (
              <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-3">
                {/* Hero ring */}
                <div className={`${CARD} flex flex-col items-center justify-center py-4 gap-1`}>
                  <PassRing value={detail.stats.passRate} label={`${detail.stats.passed} / ${detail.stats.total} passed`} />
                  <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-400">Pass rate</span>
                </div>
                {/* Counters */}
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                  <Stat icon={CheckCircle2} label="Passed" value={detail.stats.passed} cls="text-emerald-600" />
                  <Stat icon={XCircle} label="Failed" value={detail.stats.failed + detail.stats.broken} cls="text-red-600" />
                  <Stat icon={MinusCircle} label="Skipped" value={detail.stats.skipped} cls="text-gray-500" />
                  <Stat icon={Clock} label="Duration" value={formatDuration(detail.stats.durationMs)} cls="text-gray-800" />
                </div>
              </div>
            )}

            {/* Filter + search */}
            {cases.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <FilterChip active={bucket === 'all'} onClick={() => setBucket('all')} count={statusCounts.all}>All</FilterChip>
                <FilterChip active={bucket === 'passed'} onClick={() => setBucket('passed')} count={statusCounts.passed}>Passed</FilterChip>
                <FilterChip active={bucket === 'failed'} onClick={() => setBucket('failed')} count={statusCounts.failed} tone="danger">Failed</FilterChip>
                {statusCounts.not_run > 0 && <FilterChip active={bucket === 'not_run'} onClick={() => setBucket('not_run')} count={statusCounts.not_run}>Not run</FilterChip>}
                {layers.length > 1 && (
                  <>
                    <span className="w-px h-4 bg-gray-200 mx-1" />
                    <FilterChip active={layer === 'all'} onClick={() => setLayer('all')}>All layers</FilterChip>
                    {layers.map((l) => <FilterChip key={l.id} active={layer === l.id} onClick={() => setLayer(l.id)}>{l.label}</FilterChip>)}
                  </>
                )}
                <div className="relative ml-auto">
                  <Search className="w-3 h-3 text-gray-300 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search scenarios…" className={`${FIELD} w-52 pl-6 py-1`} />
                </div>
              </div>
            )}

            <div className={`${CARD} overflow-hidden`}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-[12px]">
                  <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="w-7" /><th className="text-left px-2 py-1.5 font-semibold w-[84px]">Case</th><th className="text-left px-2 py-1.5 font-semibold">Scenario</th><th className="text-left px-2 py-1.5 font-semibold w-[90px]">Layer</th><th className="text-left px-2 py-1.5 font-semibold w-[50px]">Pri</th><th className="text-left px-2 py-1.5 font-semibold w-[110px]">Status</th><th className="text-right px-4 py-1.5 font-semibold w-[130px]">Time</th></tr></thead>
                  <tbody>
                    {visible.map((c) => (
                      <CaseRowView key={c.id} c={c} maxMs={maxMs} open={expanded === c.id} onToggle={() => setExpanded(expanded === c.id ? null : c.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
              {cases.length > 0 && visible.length === 0 && (
                <p className="px-4 py-8 text-center text-[12px] text-gray-400">No scenarios match that filter.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One case row — clickable to reveal its request and, when red, its error. */
function CaseRowView({ c, maxMs, open, onToggle }: { c: CaseRow; maxMs: number; open: boolean; onToggle: () => void }) {
  const st = normStatus(c.status);
  const stripe = st === 'failed' ? 'shadow-[inset_3px_0_0_0_#F87171]' : open ? 'shadow-[inset_3px_0_0_0_#C4B5FD]' : '';
  const hasDetail = !!(c.error || c.api?.endpoint);
  return (
    <Fragment>
      <tr
        onClick={hasDetail ? onToggle : undefined}
        className={`border-t border-gray-50 align-top transition-colors ${hasDetail ? 'cursor-pointer hover:bg-[#FAFAFE]' : ''} ${open ? 'bg-[#F5F3FF]' : ''} ${stripe}`}
      >
        <td className="pl-3 py-1.5 text-gray-300">{hasDetail && <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90 text-[#7C3AED]' : ''}`} />}</td>
        <td className="px-2 py-1.5 font-mono text-[11px] text-gray-500">{c.id}</td>
        <td className="px-2 py-1.5">
          <div className="flex items-center gap-1.5">{c.api?.method && <MethodBadge method={c.api.method} />}<span className="text-gray-800">{c.title}</span></div>
          {c.api?.endpoint && <p className="font-mono text-[10.5px] text-gray-400 truncate max-w-[520px]">{c.api.endpoint}</p>}
        </td>
        <td className="px-2 py-1.5"><CategoryChip type={c.type} /></td>
        <td className="px-2 py-1.5"><PriorityChip priority={c.priority} /></td>
        <td className="px-2 py-1.5"><StatusPill status={st} /></td>
        <td className="px-4 py-1.5 text-right">
          <span className="inline-flex items-center gap-2 justify-end">
            {typeof c.durationMs === 'number' && maxMs > 0 && <DurationBar ms={c.durationMs} max={maxMs} />}
            <span className="font-mono text-[11px] text-gray-500 tabular-nums w-[52px] text-right">{typeof c.durationMs === 'number' ? formatDuration(c.durationMs) : '—'}</span>
          </span>
        </td>
      </tr>
      {open && hasDetail && (
        <tr className="border-t border-gray-100 bg-[#FAFAFE]">
          <td />
          <td colSpan={6} className="px-2 py-3 pr-4">
            {c.api?.endpoint && (
              <div className="mb-2 flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Request</span>
                {c.api.method && <MethodBadge method={c.api.method} />}
                <span className="font-mono text-[11px] text-gray-700 break-all">{c.api.endpoint}{c.api.queryParams ? `?${c.api.queryParams}` : ''}</span>
                {c.api.expectedStatus && <span className="text-[10px] text-gray-400">expects {c.api.expectedStatus}</span>}
              </div>
            )}
            {c.error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                <div className="flex items-center gap-1.5 mb-1"><AlertTriangle className="w-3.5 h-3.5 text-red-500" /><span className="text-[10px] font-semibold uppercase tracking-wide text-red-600">Failure</span></div>
                <p className="text-[11px] text-red-700 font-mono whitespace-pre-wrap break-words">{c.error}</p>
              </div>
            ) : st === 'passed' ? (
              <p className="text-[11px] text-emerald-700 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" />Passed — the response met every assertion.</p>
            ) : st === 'failed' ? (
              <p className="text-[11px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />Failed — no error detail was captured. Open the report for the full trace.</p>
            ) : (
              <p className="text-[11px] text-gray-500 flex items-center gap-1.5"><MinusCircle className="w-3.5 h-3.5" />Not run — this scenario was skipped in this run.</p>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function Stat({ icon: Icon, label, value, cls }: { icon: React.ElementType; label: string; value: string | number; cls: string }) {
  return (
    <div className={`${CARD_HOVER} p-4`}>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500"><Icon className="w-3.5 h-3.5 text-[#7C3AED]" />{label}</div>
      <div className={`mt-3 text-[28px] font-bold tabular-nums leading-none ${cls}`}>{value}</div>
    </div>
  );
}
