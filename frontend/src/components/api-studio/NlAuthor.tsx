/**
 * NlAuthor — natural-language test authoring.
 *
 * Describe what you want to test in plain English; the model returns a
 * structured brief — an editable requirements paragraph, a recommended
 * coverage depth and layer set, and a scenario outline. Applying the brief
 * feeds the SAME generator the run already uses (via the strategy); it never
 * bypasses design/execute/heal, and produces no test cases of its own.
 */
import { useState } from 'react';
import { X, Loader2, Wand2, AlertTriangle, Sparkles, Check } from 'lucide-react';
import { authorApiBrief, type NlBrief } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, CHIP_3D } from './format';
import type { CatalogEndpoint } from './types';

const EXAMPLES = [
  'Verify the login endpoint rejects expired and malformed tokens, and that a valid token returns the user profile.',
  'Stress the checkout API with invalid coupons, out-of-stock items, and negative quantities; confirm each returns the right 4xx.',
  'Smoke-test every GET endpoint returns 200 and a JSON body matching its documented shape.',
];

export default function NlAuthor({ endpoints, onApply, onClose }: {
  endpoints: CatalogEndpoint[];
  onApply: (brief: NlBrief) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [brief, setBrief] = useState<NlBrief | null>(null);
  const [editedReq, setEditedReq] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const generate = async () => {
    if (!text.trim()) { setError('Describe what you want to test.'); return; }
    setLoading(true); setError(''); setBrief(null);
    try {
      const b = await authorApiBrief(text.trim(), endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title })));
      setBrief(b); setEditedReq(b.requirements);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not generate a brief.');
    } finally { setLoading(false); }
  };

  const apply = () => {
    if (!brief) return;
    onApply({ ...brief, requirements: editedReq.trim() || brief.requirements });
    onClose();
  };

  const byUrl = new Map(endpoints.map((e) => [e.url, e]));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Wand2 className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Author tests in plain English</h3>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>What should these tests cover?</label>
            <textarea
              value={text} onChange={(e) => { setText(e.target.value); setError(''); }}
              rows={4} placeholder="e.g. Check the orders API rejects unauthenticated requests and validates the body…"
              className={`${INPUT} resize-y`}
            />
            {!brief && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {EXAMPLES.map((ex, i) => (
                  <button key={i} type="button" onClick={() => setText(ex)} className="text-[10.5px] text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded-full px-2 py-0.5 hover:bg-[#EDE9FE] text-left">
                    {ex.length > 52 ? `${ex.slice(0, 52)}…` : ex}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void generate()} disabled={loading || !text.trim()} className={PRIMARY_BTN}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {loading ? 'Thinking…' : brief ? 'Regenerate' : 'Generate brief'}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {brief && (
            <div className="space-y-3 border-t border-[#EDE9FE] pt-3">
              <div>
                <label className={LABEL}>Requirements brief <span className="text-gray-400 font-normal">— editable</span></label>
                <textarea value={editedReq} onChange={(e) => setEditedReq(e.target.value)} rows={4} className={`${INPUT} resize-y`} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Coverage</span>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded border text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE] capitalize">{brief.coverage}</span>
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 ml-2">Layers</span>
                {brief.layers.map((l) => <span key={l} className={`text-[10.5px] font-medium capitalize ${CHIP_3D}`}>{l}</span>)}
              </div>

              {brief.focus.length > 0 && (
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Focus endpoints</div>
                  <div className="space-y-0.5">
                    {brief.focus.map((u) => {
                      const e = byUrl.get(u);
                      return (
                        <div key={u} className="flex items-center gap-1.5 text-[11.5px] text-gray-600">
                          <MethodBadge method={e?.method || 'GET'} /><span className="font-mono truncate">{u}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {brief.outline.length > 0 && (
                <div>
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Scenario outline</div>
                  <ul className="space-y-0.5">
                    {brief.outline.map((o, i) => (
                      <li key={i} className="flex gap-1.5 text-[12px] text-gray-700"><Check className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0 mt-0.5" /><span className="min-w-0">{o}</span></li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <p className="text-[10.5px] text-gray-400 max-w-[60%]">Applies the coverage, layers and brief to your run strategy — the generator does the rest.</p>
                <button type="button" onClick={apply} className={PRIMARY_BTN}><Check className="w-3.5 h-3.5" />Apply to strategy</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
