/**
 * RunsView — the live run (when one is in flight) and the history.
 *
 * Live rows come from the run hook; history comes from the server and joins
 * each saved run with its execution report so the outcome per scenario is
 * visible without opening Allure.
 */
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronDown, ExternalLink, Loader2, RefreshCw, Activity, AlertTriangle, Wrench } from 'lucide-react';
import { listApiRuns, getApiRun } from '@/services/api';
import { StatusPill, MethodBadge, CategoryChip, PriorityChip, EmptyState } from '../primitives';
import { CARD, CARD_HOVER, SECONDARY_BTN, MUTED_CHIP, STRIP, THEAD, relativeTime, formatDuration } from '../format';
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
        {run.running ? <Loader2 className="w-4 h-4 text-[#7C3AED] animate-spin" /> : <Activity className="w-4 h-4 text-[#7C3AED]" />}
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
                  {r.healNote && <p className={`mt-0.5 text-[11px] flex gap-1 ${r.healed ? 'text-emerald-700' : 'text-amber-700'}`}><Wrench className="w-3 h-3 mt-px flex-shrink-0" />{r.healNote}</p>}
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

function History({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey: string }) {
  const [items, setItems] = useState<ApiRunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
      {error && <p className="px-4 py-2 text-[11.5px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
      {!loading && items.length === 0 && !error ? (
        <EmptyState icon={Activity} title="No API runs yet" hint="Runs land here once a suite has been executed — from this workspace, the CLI or the public API." />
      ) : (
        <table className="w-full text-[12px]">
          <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="text-left px-4 py-1.5 font-semibold">Run</th><th className="text-left px-2 py-1.5 font-semibold w-[110px]">Source</th><th className="text-right px-2 py-1.5 font-semibold w-[90px]">Scenarios</th><th className="text-left px-2 py-1.5 font-semibold w-[200px]">Result</th><th className="text-right px-2 py-1.5 font-semibold w-[80px]">Time</th><th className="text-right px-4 py-1.5 font-semibold w-[110px]">When</th></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.runId} onClick={() => onOpen(r.runId)} className="border-t border-gray-50 hover:bg-[#FAFAFE] hover:shadow-[inset_3px_0_0_0_#C4B5FD] transition-[background,box-shadow] cursor-pointer">
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
            ))}
          </tbody>
        </table>
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

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [state, setState] = useState<{ runId: string; detail: ApiRunDetail | null; error: string }>({ runId, detail: null, error: '' });
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-6 py-5 space-y-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className={SECONDARY_BTN}><ChevronLeft className="w-3.5 h-3.5" />All runs</button>
          {detail && (
            <>
              <div className="min-w-0"><h2 className="text-[13px] font-semibold text-gray-900 truncate">{detail.title}</h2><p className="text-[11px] text-gray-400 font-mono">{detail.runId} · {detail.createdBy} · {relativeTime(detail.createdAt)}</p></div>
              {detail.reportUrl && <a href={detail.reportUrl} target="_blank" rel="noreferrer" className={`ml-auto ${SECONDARY_BTN}`}><ExternalLink className="w-3.5 h-3.5" />{detail.hasAllure ? 'Allure report' : 'Report'}</a>}
            </>
          )}
        </div>
        {error && <p className="text-[12px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />{error}</p>}
        {!detail && !error && <Loader.Block label="Loading run" />}
        {detail && (
          <>
            {detail.stats && (
              <div className="grid grid-cols-5 gap-2">
                <Stat label="Pass rate" value={`${detail.stats.passRate}%`} cls={detail.stats.passRate >= 90 ? 'text-emerald-600' : detail.stats.passRate >= 70 ? 'text-amber-600' : 'text-red-600'} />
                <Stat label="Passed" value={detail.stats.passed} cls="text-emerald-600" />
                <Stat label="Failed" value={detail.stats.failed + detail.stats.broken} cls="text-red-600" />
                <Stat label="Skipped" value={detail.stats.skipped} cls="text-gray-500" />
                <Stat label="Duration" value={formatDuration(detail.stats.durationMs)} cls="text-gray-800" />
              </div>
            )}
            <div className={`${CARD} overflow-hidden`}>
              <table className="w-full text-[12px]">
                <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="text-left px-4 py-1.5 font-semibold w-[90px]">Case</th><th className="text-left px-2 py-1.5 font-semibold">Scenario</th><th className="text-left px-2 py-1.5 font-semibold w-[90px]">Layer</th><th className="text-left px-2 py-1.5 font-semibold w-[50px]">Pri</th><th className="text-left px-2 py-1.5 font-semibold w-[110px]">Status</th><th className="text-right px-4 py-1.5 font-semibold w-[80px]">Time</th></tr></thead>
                <tbody>
                  {detail.cases.map((c) => (
                    <tr key={c.id} className="border-t border-gray-50 align-top">
                      <td className="px-4 py-1.5 font-mono text-[11px] text-gray-500">{c.id}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">{c.api?.method && <MethodBadge method={c.api.method} />}<span className="text-gray-800">{c.title}</span></div>
                        {c.api?.endpoint && <p className="font-mono text-[10.5px] text-gray-400 truncate max-w-[520px]">{c.api.endpoint}</p>}
                        {c.error && <p className="mt-0.5 text-[11px] text-red-600 font-mono whitespace-pre-wrap break-words">{c.error}</p>}
                      </td>
                      <td className="px-2 py-1.5"><CategoryChip type={c.type} /></td>
                      <td className="px-2 py-1.5"><PriorityChip priority={c.priority} /></td>
                      <td className="px-2 py-1.5"><StatusPill status={c.status === 'broken' ? 'failed' : c.status === 'skipped' || c.status === 'unknown' ? 'not_run' : c.status} /></td>
                      <td className="px-4 py-1.5 text-right font-mono text-[11px] text-gray-500 tabular-nums">{typeof c.durationMs === 'number' ? formatDuration(c.durationMs) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string | number; cls: string }) {
  return <div className={`${CARD_HOVER} p-3`}><p className="text-[10.5px] uppercase tracking-wide text-gray-500 font-semibold">{label}</p><p className={`mt-1 text-[20px] font-semibold tabular-nums leading-none ${cls}`}>{value}</p></div>;
}
