/**
 * StoryGen — turn a Jira story / PRD / acceptance criteria into a test plan.
 *
 * Paste the narrative; the backend maps each acceptance criterion to the
 * endpoints already in the catalogue and drafts test ideas per criterion, then
 * folds the whole thing into an `AttoBrief` the run can adopt as its strategy.
 * Standalone and read-only until the user clicks "Apply" — nothing here mutates
 * the pipeline on its own.
 */
import { useState } from 'react';
import { FileText, X, AlertTriangle, Sparkles } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { generateFromStory, type StoryGenResult, type AcceptanceCriterion, type AttoBrief } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

/** Human labels for the criterion kinds — the raw enum reads as jargon. */
const KIND_LABEL: Record<AcceptanceCriterion['kind'], string> = {
  'happy-path': 'Happy path',
  negative: 'Negative',
  auth: 'Auth',
  validation: 'Validation',
  edge: 'Edge',
  other: 'Other',
};

export default function StoryGen({ endpoints, onApply, onClose }: { endpoints: CatalogEndpoint[]; onApply: (brief: AttoBrief) => void; onClose: () => void }) {
  const toast = useToast();
  const [story, setStory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StoryGenResult | null>(null);

  const run = async () => {
    const text = story.trim();
    if (!text || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await generateFromStory({
        story: text,
        endpoints: endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title })),
      });
      setResult(res);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not generate a plan from the story.');
    } finally {
      setLoading(false);
    }
  };

  const apply = () => {
    if (!result) return;
    onApply(result.brief);
    toast.success('Strategy updated', 'Generation will follow this plan.');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FileText className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Story-driven generation</h3>
          <span className="text-[11px] text-gray-400">Jira story / PRD → a test plan</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* Story input */}
          <div>
            <label className={LABEL}>Story / PRD / acceptance criteria</label>
            <textarea
              value={story}
              onChange={(e) => setStory(e.target.value)}
              rows={8}
              placeholder={'Paste the Jira story, PRD section, or acceptance criteria…\n\nAs a user I can reset my password so that I regain access.\n- Given a valid email, a reset link is sent.\n- An unknown email returns a generic 200.'}
              disabled={loading}
              className={`${INPUT} resize-y`}
            />
            <p className="text-[11px] text-gray-400 mt-1">Each acceptance criterion is mapped to endpoints in your catalogue and turned into test ideas.</p>
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void run()} disabled={loading || !story.trim()} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Generate plan
            </button>
          </div>

          {/* Result */}
          {result && (
            <div className="space-y-3">
              <div className={`${CARD} p-3`}>
                <p className="text-[13px] font-semibold text-gray-900">{result.title}</p>
                {result.summary && <p className="text-[12px] text-gray-600 mt-1 whitespace-pre-wrap break-words">{result.summary}</p>}
              </div>

              {result.unmappedCriteria > 0 && (
                <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
                  <p className="text-[12px] text-amber-700 min-w-0">
                    {result.unmappedCriteria} cri{result.unmappedCriteria === 1 ? 'terion' : 'teria'} couldn&apos;t be tied to a catalogue endpoint.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                {result.criteria.map((c: AcceptanceCriterion) => (
                  <div key={c.id} className={`${CARD} p-3 space-y-2`}>
                    <div className="flex items-start gap-2">
                      <p className="text-[12px] text-gray-800 min-w-0 flex-1 break-words">{c.text}</p>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">
                        {KIND_LABEL[c.kind] || c.kind}
                      </span>
                    </div>

                    {c.endpoints.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {c.endpoints.map((url, i) => (
                          <span key={i} className="inline-flex items-center max-w-[220px] truncate px-1.5 py-0.5 rounded border text-[10.5px] font-mono text-gray-600 bg-gray-50 border-gray-200">
                            {url}
                          </span>
                        ))}
                      </div>
                    )}

                    {c.testIdeas.length > 0 && (
                      <ul className="list-disc list-inside space-y-0.5">
                        {c.testIdeas.map((idea, i) => (
                          <li key={i} className="text-[11.5px] text-gray-600 break-words">{idea}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Apply */}
        {result && (
          <div className="border-t border-gray-100 p-3 flex justify-end flex-shrink-0">
            <button type="button" onClick={apply} className={PRIMARY_BTN}>Apply as run strategy</button>
          </div>
        )}
      </div>
    </div>
  );
}
