/**
 * ImpactAnalysis — history- & flow-aware test selection.
 *
 * The reviewer pastes the endpoints that changed; the backend walks the catalogue
 * and the known flows to select the tests a change actually puts at risk —
 * structurally (same request signature) and transitively (a flow that touches it).
 * Read-only: it recommends what to run, it does not run or mutate anything.
 */
import { useState } from 'react';
import { GitCompareArrows, X, AlertTriangle, Sparkles } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import { MethodBadge, EmptyState } from './primitives';
import type { CatalogEndpoint } from './types';
import { analyzeImpactDeep, type DeepImpactResult, type ImpactedEndpoint, type ImpactedFlow } from '@/services/api';

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;

/** `via` value → the app's chip tone. */
function viaTone(via: string): string {
  return via === 'flow'
    ? 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]'
    : 'text-blue-700 bg-blue-50 border-blue-200';
}

/** One changed endpoint per line — either `url` or `METHOD url`. */
function parseChanged(text: string): { method?: string; url: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.search(/\s/);
      if (sp === -1) return { url: line };
      const first = line.slice(0, sp);
      const rest = line.slice(sp + 1).trim();
      if (METHOD_RE.test(first) && rest) return { method: first.toUpperCase(), url: rest };
      return { url: line };
    });
}

const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium';
const STAT = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-[11px] text-gray-600';

export default function ImpactAnalysis({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [result, setResult] = useState<DeepImpactResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const analyze = async () => {
    const changed = parseChanged(text);
    if (changed.length === 0) {
      setError('Add at least one changed endpoint — one per line.');
      return;
    }
    setLoading(true); setError('');
    try {
      const res = await analyzeImpactDeep({
        changed,
        endpoints: endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url })),
      });
      setResult(res);
      toast.success(`${res.summary.total} impacted test${res.summary.total === 1 ? '' : 's'}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not analyze impact.');
    } finally {
      setLoading(false);
    }
  };

  const stats = result
    ? [
        { label: 'candidates', value: result.summary.candidates },
        { label: 'structural', value: result.summary.structural },
        { label: 'with flows', value: result.summary.withFlows },
        { label: 'total', value: result.summary.total },
        { label: 'selected', value: `${result.summary.selectedPct}%` },
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
          <GitCompareArrows className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Change impact</h3>
          <span className="text-[11px] text-gray-400">History- &amp; flow-aware test selection</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {errorBlock}

          {/* Input */}
          <div>
            <label className={LABEL}>Changed endpoints</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder={'POST https://api.x.com/orders\nhttps://api.x.com/v1/users/{id}'}
              className={`${INPUT} font-mono resize-y`}
            />
            <p className="text-[10.5px] text-gray-400 mt-1">One per line — a URL, or a method and URL (e.g. <code>POST https://api.x.com/orders</code>).</p>
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void analyze()} disabled={loading || !text.trim()} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}Analyze impact
            </button>
          </div>

          {result && (
            <>
              {/* Summary */}
              <div className="flex flex-wrap gap-1.5">
                {stats.map((s) => (
                  <span key={s.label} className={STAT}><span className="font-semibold text-gray-900 tabular-nums">{s.value}</span>{s.label}</span>
                ))}
              </div>

              {/* Impacted tests */}
              <div>
                <label className={LABEL}>Impacted tests</label>
                {result.impacted.length === 0 ? (
                  <EmptyState icon={GitCompareArrows} title="Nothing impacted" hint="None of the catalogue endpoints or flows match the changes you listed." />
                ) : (
                  <div className="space-y-1.5">
                    {result.impacted.map((ep: ImpactedEndpoint, i) => (
                      <div key={ep.id || `${ep.method}-${ep.url}-${i}`} className={`${CARD} px-3 py-2`}>
                        <div className="flex items-center gap-2">
                          <MethodBadge method={ep.method} />
                          <span className="flex-1 min-w-0 truncate text-[12px] font-mono text-gray-700" title={ep.url}>{ep.url}</span>
                          {ep.via.map((v) => (
                            <span key={v} className={`${CHIP} flex-shrink-0 ${viaTone(v)}`}>{v}</span>
                          ))}
                          <span className="text-[12px] font-semibold text-gray-900 tabular-nums flex-shrink-0">{ep.priorityScore}</span>
                        </div>
                        {(ep.failRate > 0 || ep.viaFlows.length > 0) && (
                          <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
                            {ep.failRate > 0 && <span className={`${CHIP} text-amber-700 bg-amber-50 border-amber-200`}>{ep.failRate}% fail</span>}
                            {ep.viaFlows.length > 0 && <span className="text-[11px] text-gray-400 min-w-0 break-words">{ep.viaFlows.join(' · ')}</span>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Impacted flows */}
              {result.flows.length > 0 && (
                <div>
                  <label className={LABEL}>Impacted flows</label>
                  <div className="space-y-2">
                    {result.flows.map((f: ImpactedFlow) => (
                      <div key={f.id} className={`${CARD} px-3 py-2 space-y-1.5`}>
                        <p className="text-[12px] font-medium text-gray-800">{f.name}</p>
                        {f.matchedSignatures.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {f.matchedSignatures.map((sig, j) => (
                              <span key={`${sig}-${j}`} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE] break-all">{sig}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
