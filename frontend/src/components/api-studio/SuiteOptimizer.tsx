/**
 * SuiteOptimizer — a read-only advisory view over the whole suite.
 *
 * On open it asks the backend to score every catalogue endpoint by risk
 * (fail rate, traffic, quarantine state) and to group near-duplicate requests
 * so the reviewer can see what to run first and what is redundant. Nothing here
 * mutates the catalogue or the pipeline — the redundancy note is advice only.
 */
import { useState, useEffect } from 'react';
import { ListFilter, X, AlertTriangle, RefreshCw } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { CARD, STRIP, LABEL, SECONDARY_BTN } from './format';
import { MethodBadge, EmptyState } from './primitives';
import type { CatalogEndpoint } from './types';
import { optimizeSuite, type SuiteOptimizerResult, type PrioritizedEndpoint, type RedundancyCluster } from '@/services/api';

/** Priority/severity → the app's chip tone. */
function priorityTone(priority: string): string {
  switch (priority) {
    case 'critical': return 'text-red-700 bg-red-50 border-red-200';
    case 'high': return 'text-amber-700 bg-amber-50 border-amber-200';
    case 'medium': return 'text-blue-700 bg-blue-50 border-blue-200';
    default: return 'text-gray-600 bg-gray-50 border-gray-200';
  }
}

const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium';
const STAT = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-[11px] text-gray-600';

export default function SuiteOptimizer({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [result, setResult] = useState<SuiteOptimizerResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const run = async (notify = false) => {
    setLoading(true); setError('');
    try {
      const res = await optimizeSuite({ endpoints });
      setResult(res);
      if (notify) toast.success('Suite re-analyzed');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not optimize the suite.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = result
    ? [
        { label: 'endpoints', value: result.summary.endpoints },
        { label: 'redundant groups', value: result.summary.redundantGroups },
        { label: 'prunable', value: result.summary.prunable },
        { label: 'critical', value: result.summary.critical },
        { label: 'high', value: result.summary.high },
        { label: 'runs analyzed', value: result.runsAnalyzed },
      ]
    : [];

  const errorBlock = error ? (
    <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
      <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
      <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
    </div>
  ) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ListFilter className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Suite optimizer</h3>
          <span className="text-[11px] text-gray-400">Risk priority + redundancy pruning</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {errorBlock}

          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-gray-500 min-w-0">Endpoints ordered by risk; near-duplicate requests grouped so you can keep one and prune the rest.</p>
            <button type="button" onClick={() => void run(true)} disabled={loading} className={`${SECONDARY_BTN} flex-shrink-0`}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Re-run
            </button>
          </div>

          {loading && !result ? (
            <div className="flex items-center justify-center py-12 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : result ? (
            <>
              {/* Summary */}
              <div className="flex flex-wrap gap-1.5">
                {stats.map((s) => (
                  <span key={s.label} className={STAT}><span className="font-semibold text-gray-900 tabular-nums">{s.value}</span>{s.label}</span>
                ))}
              </div>

              {/* Prioritized */}
              <div>
                <label className={LABEL}>Prioritized</label>
                {result.prioritized.length === 0 ? (
                  <EmptyState icon={ListFilter} title="Nothing to prioritize" hint="No endpoints were scored — import a few and run the suite to build history." />
                ) : (
                  <div className="space-y-1.5">
                    {result.prioritized.map((p: PrioritizedEndpoint, i) => (
                      <div key={p.id || `${p.method}-${p.url}-${i}`} className={`${CARD} px-3 py-2`}>
                        <div className="flex items-center gap-2">
                          <MethodBadge method={p.method} />
                          <span className="flex-1 min-w-0 truncate text-[12px] font-mono text-gray-700" title={p.url}>{p.url}</span>
                          <span className={`${CHIP} flex-shrink-0 ${priorityTone(p.priority)}`}>{p.priority}</span>
                          <span className="text-[12px] font-semibold text-gray-900 tabular-nums flex-shrink-0">{p.score}</span>
                        </div>
                        {(p.failRate > 0 || p.traffic > 0 || p.quarantined || p.reasons.length > 0) && (
                          <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
                            {p.failRate > 0 && <span className={`${CHIP} text-amber-700 bg-amber-50 border-amber-200`}>{p.failRate}% fail</span>}
                            {p.traffic > 0 && <span className={`${CHIP} text-gray-600 bg-gray-50 border-gray-200`}>{p.traffic}× traffic</span>}
                            {p.quarantined && <span className={`${CHIP} text-red-700 bg-red-50 border-red-200`}>quarantined</span>}
                            {p.reasons.length > 0 && <span className="text-[11px] text-gray-400 min-w-0 break-words">{p.reasons.join(' · ')}</span>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Redundant groups */}
              {result.redundancies.length > 0 && (
                <div>
                  <label className={LABEL}>Redundant groups</label>
                  <div className="space-y-2">
                    {result.redundancies.map((cluster: RedundancyCluster, i) => (
                      <div key={cluster.signature || i} className={`${CARD} px-3 py-2 space-y-1.5`}>
                        <code className="inline-block text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1.5 py-0.5 break-all">{cluster.signature}</code>
                        <div className="space-y-1">
                          {cluster.endpoints.map((e, j) => (
                            <div key={e.id || `${e.method}-${e.url}-${j}`} className="flex items-center gap-2">
                              <MethodBadge method={e.method} />
                              <span className="flex-1 min-w-0 truncate text-[12px] font-mono text-gray-600" title={e.url}>{e.url}</span>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10.5px] text-gray-400">Keep one representative; the rest are near-duplicates.</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
