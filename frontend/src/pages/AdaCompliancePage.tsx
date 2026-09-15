/**
 * ADA Compliance — standalone page.
 *
 * Lists this tenant's website audits and hosts the audit panel: start a new
 * audit or open a finished one. The same panel is embedded in the Chat wizard.
 */
import { useCallback, useEffect, useState } from 'react';

import { useNavigate } from 'react-router-dom';
import { listAdaScans, deleteAdaScan, cancelAdaScan, type AdaScanRecord } from '@/services/api';
import AdaCompliancePanel, { type BrownfieldHandoff } from '@/components/ada/AdaCompliancePanel';
import { Accessibility, Plus, Trash2, Loader2, Clock, CheckCircle2, XCircle, Square, ChevronLeft } from 'lucide-react';

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | undefined;
  return e?.response?.data?.error || e?.message || fallback;
}

const GRADE_COLOR = (score: number | null | undefined) =>
  score == null ? 'text-gray-400' : score >= 90 ? 'text-emerald-600' : score >= 80 ? 'text-green-600' : score >= 70 ? 'text-amber-600' : score >= 60 ? 'text-orange-600' : 'text-red-600';

const STATUS_ICON: Record<AdaScanRecord['status'], React.ElementType> = {
  queued: Clock, running: Loader2, completed: CheckCircle2, failed: XCircle, cancelled: Square,
};

export default function AdaCompliancePage() {
  const navigate = useNavigate();
  const [scans, setScans] = useState<AdaScanRecord[] | null>(null);
  const [mode, setMode] = useState<'list' | 'new' | 'view'>('list');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    listAdaScans()
      .then((rows) => { if (alive) { setScans(rows); setError(''); } })
      .catch((err: unknown) => { if (alive) { setError(errorMessage(err, 'Could not load audits')); setScans([]); } });
    return () => { alive = false; };
  }, [reloadTick]);
  // Keep the list fresh while an audit is running in the background.
  const anyRunning = mode === 'list' && !!scans?.some((s) => s.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const [stopping, setStopping] = useState<string | null>(null);
  const stop = async (id: string) => {
    setStopping(id);
    try { await cancelAdaScan(id); setTimeout(load, 2000); } catch (err: unknown) { setError(errorMessage(err, 'Could not stop the audit')); }
    finally { setTimeout(() => setStopping(null), 2000); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this audit and all of its findings?')) return;
    try { await deleteAdaScan(id); load(); } catch (err: unknown) { setError(errorMessage(err, 'Delete failed')); }
  };

  // Hand the crawled site to the Chat wizard's explore flow.
  const brownfield = (ctx: BrownfieldHandoff) => {
    sessionStorage.setItem('intelliqe_ada_brownfield', JSON.stringify(ctx));
    navigate('/chat');
  };

  const backToList = () => { setMode('list'); setSelected(null); load(); };

  if (mode !== 'list') {
    return (
      <div className="p-6 space-y-4">
        <button onClick={backToList} className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1"><ChevronLeft className="w-3.5 h-3.5" /> All audits</button>
        <AdaCompliancePanel initialScanId={mode === 'view' ? selected || undefined : undefined} onBrownfield={brownfield} onReset={backToList} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <Accessibility className="w-5 h-5 text-violet-500" /> ADA Compliance
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Give IntelliQE a website address. It crawls every page it can reach and reports accessibility (WCAG 2.2 AA) violations, broken links and best-practice issues as one scored health report.
          </p>
        </div>
        <button onClick={() => setMode('new')} className="flex-shrink-0 px-3.5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium rounded-lg flex items-center gap-2 transition-all">
          <Plus className="w-4 h-4" /> New audit
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}

      <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
        {scans === null ? (
          <p className="p-6 text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
        ) : scans.length === 0 ? (
          <div className="p-10 text-center">
            <Accessibility className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-600">No audits yet.</p>
            <p className="text-xs text-gray-400 mt-1">Start one with a single URL — no requirements or setup needed.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100 bg-gray-50/60">
                <th className="px-4 py-2.5 font-medium">Website</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Health</th>
                <th className="px-4 py-2.5 font-medium text-right">Pages</th>
                <th className="px-4 py-2.5 font-medium text-right">Links</th>
                <th className="px-4 py-2.5 font-medium text-right">Issues</th>
                <th className="px-4 py-2.5 font-medium">Run</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {scans.map((s) => {
                const Icon = STATUS_ICON[s.status] || Clock;
                const openable = s.status === 'completed' || s.status === 'cancelled' || s.status === 'running';
                return (
                  <tr key={s.id} className="border-b border-gray-50 hover:bg-violet-50/30 transition-colors">
                    <td className="px-4 py-3">
                      <button disabled={!openable} onClick={() => { setSelected(s.id); setMode('view'); }} className="text-left disabled:cursor-default">
                        <p className="text-gray-800 font-medium">{s.site_name || s.target_url}</p>
                        <p className="text-[11px] text-gray-400 truncate max-w-[360px]">{s.target_url}</p>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 text-xs ${s.status === 'completed' ? 'text-emerald-600' : s.status === 'failed' ? 'text-red-600' : s.status === 'running' ? 'text-violet-600' : 'text-gray-500'}`}>
                        <Icon className={`w-3.5 h-3.5 ${s.status === 'running' ? 'animate-spin' : ''}`} /> {s.status}
                      </span>
                      {s.status === 'failed' && s.error && <p className="text-[11px] text-red-500 mt-0.5 max-w-[240px] truncate" title={s.error}>{s.error}</p>}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${GRADE_COLOR(s.overall_score)}`}>{s.overall_score ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{s.pages_crawled}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{s.links_checked}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{s.findings_count}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(s.created_at).toLocaleString()}
                      {s.created_by && <span className="block text-[11px] text-gray-400">{s.created_by}</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.status === 'running' ? (
                        <button onClick={() => stop(s.id)} disabled={stopping === s.id} className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-red-600 border border-gray-200 hover:border-red-200 bg-white rounded-lg px-2.5 py-1 transition-colors disabled:opacity-50" title="Stop now and keep the report for the pages audited so far">
                          <Square className="w-3 h-3 fill-current" /> {stopping === s.id ? 'Stopping…' : 'Stop & report'}
                        </button>
                      ) : (
                        <button onClick={() => remove(s.id)} className="text-gray-300 hover:text-red-500 transition-colors" title="Delete audit"><Trash2 className="w-4 h-4" /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
