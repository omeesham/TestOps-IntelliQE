/**
 * SemanticAssert — AI-response assertions for non-deterministic / AI-native
 * endpoints. Pick an endpoint, describe in plain English what the response
 * should satisfy, and the tenant model judges the live response (pass/fail +
 * rationale). Opt-in and standalone — live-probes the API, touches no pipeline.
 */
import { useMemo, useState } from 'react';
import { X, Sparkles, Play, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runSemanticAssertion, type SemanticAssertResult } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const EXAMPLES = [
  'The response is a friendly, grammatical English sentence that answers the question.',
  'The summary is under 3 sentences and mentions the order status.',
  'The list contains at least 3 product recommendations, each with a name and price.',
  'The chatbot reply politely declines and does not reveal internal system details.',
];

export default function SemanticAssert({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [intent, setIntent] = useState('');
  const [result, setResult] = useState<SemanticAssertResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const ep = endpoints[Math.min(idx, endpoints.length - 1)];
  const placeholder = useMemo(() => EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)], []);

  const run = async () => {
    if (!ep || !intent.trim()) return;
    setLoading(true); setError(''); setResult(null);
    try {
      setResult(await runSemanticAssertion({ id: ep.id, title: ep.title, method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body }, intent));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Semantic assertion failed.');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Sparkles className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Semantic assertion</h3>
          <span className="text-[11px] text-gray-400">judge AI / non-deterministic responses by intent</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Endpoint</label>
            <select value={idx} onChange={(e) => { setIdx(Number(e.target.value)); setResult(null); }} className={INPUT}>
              {endpoints.map((e, i) => <option key={e.id} value={i}>{e.method} {e.url}</option>)}
            </select>
          </div>
          {ep && <div className="flex items-center gap-2 text-[11.5px] text-gray-500"><MethodBadge method={ep.method} /><span className="font-mono truncate">{ep.url}</span></div>}

          <div>
            <label className={LABEL}>Intent — what should the response satisfy?</label>
            <textarea value={intent} onChange={(e) => { setIntent(e.target.value); setError(''); }} rows={3} placeholder={placeholder} className={`${INPUT} resize-y`} />
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void run()} disabled={loading || !ep || !intent.trim()} className={PRIMARY_BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{loading ? 'Calling & judging…' : 'Assert'}</button>
          </div>

          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700">{error}</p></div>}

          {result && (
            <div className="space-y-2">
              <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${result.passed ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                {result.passed ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <XCircle className="w-5 h-5 text-red-600" />}
                <div className="min-w-0">
                  <div className={`text-[13px] font-semibold ${result.passed ? 'text-emerald-700' : 'text-red-700'}`}>{result.passed ? 'Satisfied' : 'Not satisfied'} <span className="font-normal text-gray-400">· {result.confidence} confidence</span></div>
                  <div className="text-[12px] text-gray-600">{result.rationale}</div>
                </div>
              </div>
              <div className="text-[11px] text-gray-400">
                Response: <span className="font-mono">{result.observed.status ?? (result.observed.error ? 'error' : '—')}</span> · {result.observed.elapsedMs}ms
              </div>
              {result.observed.bodyPreview && <pre className="text-[10.5px] font-mono text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto max-h-32">{result.observed.bodyPreview}</pre>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
