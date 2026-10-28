/**
 * StoryGen — turn a Jira story / PRD / acceptance criteria into a test plan.
 *
 * Paste the narrative; the backend maps each acceptance criterion to the
 * endpoints already in the catalogue and drafts test ideas per criterion, then
 * folds the whole thing into an `AttoBrief` the run can adopt as its strategy.
 *
 * Before any of that can be applied, every endpoint the story reaches has to
 * clear a four-point checklist: its purpose, inputs, expected responses and
 * business rules are captured; it links back to a source; a reviewer has
 * approved it; and the run will happen somewhere customer-similar. The first,
 * second and fourth are decided by the backend — the third is decided here,
 * which is the whole point of it: a person reads each requirement and approves
 * or rejects it before planning starts. Rejected endpoints are dropped from the
 * brief, so the planner only ever sees what was approved.
 *
 * Standalone and read-only until the user clicks "Apply" — nothing here mutates
 * the pipeline on its own.
 */
import { useMemo, useState } from 'react';
import {
  FileText, X, AlertTriangle, Sparkles, CheckCircle2, XCircle, Link2,
  ChevronDown, ChevronRight, ShieldCheck, Undo2,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  generateFromStory,
  type StoryGenResult, type AcceptanceCriterion, type AttoBrief,
  type EndpointRequirement, type ChecklistItem, type ReqSourceRef,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, BRAND_CHIP, pathOf } from './format';
import type { CatalogEndpoint, ApiEnvironment } from './types';

/** Human labels for the criterion kinds — the raw enum reads as jargon. */
const KIND_LABEL: Record<AcceptanceCriterion['kind'], string> = {
  'happy-path': 'Happy path',
  negative: 'Negative',
  auth: 'Auth',
  validation: 'Validation',
  edge: 'Edge',
  other: 'Other',
};

type ReviewState = 'approved' | 'rejected';

/** Pass/fail is an outcome, so it is the one thing here that carries colour. */
function CheckRow({ item, pass, detail }: { item: ChecklistItem; pass?: boolean; detail?: string }) {
  const ok = pass ?? item.pass;
  const text = detail ?? item.detail;
  return (
    <div className="flex items-start gap-2 py-1.5">
      {ok
        ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-px" />
        : <XCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-px" />}
      <div className="min-w-0 flex-1">
        <p className={`text-[12px] ${ok ? 'text-gray-800' : 'text-gray-900 font-medium'}`}>{item.label}</p>
        <p className="text-[11px] text-gray-500 break-words">{text}</p>
      </div>
    </div>
  );
}

function SourceChip({ s }: { s: ReqSourceRef }) {
  const body = (
    <>
      <Link2 className="w-3 h-3 flex-shrink-0" />
      <span className="font-medium">{s.label}</span>
      <span className="text-gray-400">·</span>
      <span className="font-mono truncate">{s.ref}</span>
      {!s.verified && <span className="text-amber-600 flex-shrink-0">unconfirmed</span>}
    </>
  );
  const cls = `inline-flex items-center gap-1 max-w-[280px] px-1.5 py-0.5 rounded border text-[10.5px] ${
    s.verified ? BRAND_CHIP : 'text-amber-700 bg-amber-50 border-amber-200'
  }`;
  return s.url
    ? <a href={s.url} target="_blank" rel="noreferrer" className={`${cls} hover:underline`} title={s.detail}>{body}</a>
    : <span className={cls} title={s.detail}>{body}</span>;
}

function RequirementCard({
  req, review, onReview, defaultOpen,
}: {
  req: EndpointRequirement;
  review?: ReviewState;
  onReview: (state: ReviewState | undefined) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className={`${CARD} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#FAF9FE]"
      >
        <Chevron className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold flex-shrink-0 ${BRAND_CHIP}`}>
          {req.method}
        </span>
        <span className="text-[12px] font-mono text-gray-700 truncate min-w-0 flex-1">{pathOf(req.url)}</span>
        {review === 'approved' && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium text-emerald-700 bg-emerald-50 border-emerald-200 flex-shrink-0">Approved</span>}
        {review === 'rejected' && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium text-rose-700 bg-rose-50 border-rose-200 flex-shrink-0">Rejected</span>}
        {!review && (
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${
            req.ready ? 'text-gray-600 bg-gray-50 border-gray-200' : 'text-rose-700 bg-rose-50 border-rose-200'
          }`}>
            {req.ready ? 'Needs review' : 'Incomplete'}
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-gray-100 pt-2.5">
          {/* The four captured parts */}
          <div>
            <p className={LABEL}>Purpose</p>
            <p className="text-[12px] text-gray-800 break-words">{req.purpose || <span className="text-rose-600">Not captured.</span>}</p>
          </div>

          <div>
            <p className={LABEL}>Inputs</p>
            {req.inputs.length === 0
              ? <p className="text-[11.5px] text-gray-400">None captured.</p>
              : (
                <div className="space-y-1">
                  {req.inputs.map((i, n) => (
                    <div key={n} className="flex items-baseline gap-2 text-[11.5px]">
                      <span className="font-mono text-gray-800 flex-shrink-0">{i.name}</span>
                      <span className="text-gray-400 flex-shrink-0">{i.in}</span>
                      {i.required && <span className="text-[10px] text-gray-500 flex-shrink-0">required</span>}
                      {i.note && <span className="text-gray-500 min-w-0 break-words">— {i.note}</span>}
                    </div>
                  ))}
                </div>
              )}
          </div>

          <div>
            <p className={LABEL}>Expected responses</p>
            {req.expectedResponses.length === 0
              ? <p className="text-[11.5px] text-gray-400">None captured.</p>
              : (
                <div className="space-y-1">
                  {req.expectedResponses.map((r, n) => (
                    <div key={n} className="flex items-baseline gap-2 text-[11.5px]">
                      <span className={`font-mono font-semibold flex-shrink-0 ${r.status < 400 ? 'text-emerald-700' : 'text-rose-600'}`}>{r.status}</span>
                      <span className="text-gray-600 min-w-0 break-words">{r.when}</span>
                    </div>
                  ))}
                </div>
              )}
          </div>

          <div>
            <p className={LABEL}>Business rules</p>
            {req.businessRules.length === 0
              ? <p className="text-[11.5px] text-gray-400">None captured.</p>
              : (
                <ul className="list-disc list-inside space-y-0.5">
                  {req.businessRules.map((b, n) => <li key={n} className="text-[11.5px] text-gray-700 break-words">{b}</li>)}
                </ul>
              )}
          </div>

          <div>
            <p className={LABEL}>Source</p>
            {req.sources.length === 0
              ? <p className="text-[11.5px] text-rose-600">Nothing to trace this back to.</p>
              : <div className="flex flex-wrap gap-1.5">{req.sources.map((s, n) => <SourceChip key={n} s={s} />)}</div>}
          </div>

          {/* This endpoint's own checklist */}
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-2.5 py-1">
            {req.checklist.map((c) => (
              <CheckRow
                key={c.id}
                item={c}
                pass={c.id === 'reviewed' ? review === 'approved' : undefined}
                detail={c.id === 'reviewed' && review
                  ? (review === 'approved' ? 'Approved for planning.' : 'Rejected — it will be left out of the plan.')
                  : undefined}
              />
            ))}
          </div>

          {/* The reviewer's decision — checklist item 3 */}
          <div className="flex items-center gap-2">
            {review ? (
              <button type="button" onClick={() => onReview(undefined)} className={SECONDARY_BTN}>
                <Undo2 className="w-3.5 h-3.5" /> Undo
              </button>
            ) : (
              <>
                <button type="button" onClick={() => onReview('approved')} className={PRIMARY_BTN}>
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                </button>
                <button type="button" onClick={() => onReview('rejected')} className={SECONDARY_BTN}>
                  <XCircle className="w-3.5 h-3.5" /> Reject
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function StoryGen({
  endpoints, environment, onApply, onClose,
}: {
  endpoints: CatalogEndpoint[];
  /** The environment the run would target — decides the customer-similar check. */
  environment?: ApiEnvironment | null;
  /** `approvedUrls` is what survived review — the caller narrows the run to it. */
  onApply: (brief: AttoBrief, approvedUrls: string[]) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [story, setStory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StoryGenResult | null>(null);
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({});

  const run = async () => {
    const text = story.trim();
    if (!text || loading) return;
    setLoading(true);
    setError('');
    setReviews({});
    try {
      const res = await generateFromStory({
        story: text,
        endpoints: endpoints.map((e) => ({
          method: e.method, url: e.url, title: e.title, operationId: e.operationId,
          description: e.description, source: e.source,
          pathParams: e.pathParams, queryParams: e.queryParams, body: e.body,
        })),
        environment: environment ? { name: environment.name, customerLike: !!environment.customerLike } : null,
      });
      setResult(res);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not generate a plan from the story.');
    } finally {
      setLoading(false);
    }
  };

  const reqs = result?.endpointRequirements || [];
  const approved = useMemo(() => reqs.filter((r) => reviews[r.url] === 'approved'), [reqs, reviews]);
  const reviewed = useMemo(() => reqs.filter((r) => reviews[r.url]), [reqs, reviews]);

  /**
   * The gate. Items 1, 2 and 3 must hold for everything that will be planned;
   * item 4 only warns, because the environment can still be changed before the
   * run and the attestation itself is made at release time.
   */
  const blocked = useMemo(() => {
    if (!result) return 'Generate a plan first.';
    if (!reqs.length) return 'The story did not reach any endpoint in your catalogue, so there is nothing to plan.';
    if (reviewed.length < reqs.length) return `${reqs.length - reviewed.length} requirement${reqs.length - reviewed.length === 1 ? '' : 's'} still waiting on your review.`;
    if (!approved.length) return 'Every requirement was rejected, so there is nothing left to plan.';
    const incomplete = approved.filter((r) => !r.checklist.find((c) => c.id === 'captured')?.pass || !r.checklist.find((c) => c.id === 'source')?.pass);
    if (incomplete.length) return `${incomplete.length} approved requirement${incomplete.length === 1 ? '' : 's'} ${incomplete.length === 1 ? 'is' : 'are'} still missing part of the checklist. Reject ${incomplete.length === 1 ? 'it' : 'them'}, or re-run with a fuller story.`;
    return '';
  }, [result, reqs, reviewed, approved]);

  const envWarning = useMemo(
    () => result && approved.length > 0 && !result.checklist.find((c) => c.id === 'signed-off')?.pass,
    [result, approved],
  );

  const apply = () => {
    if (!result || blocked) return;
    const keep = new Set(approved.map((r) => r.url));
    const keptCriteria = result.criteria.filter((c) => c.endpoints.some((u) => keep.has(u)));
    // The approved requirements' rules travel with the brief, so the generator
    // plans against what the reviewer actually signed up to.
    const rules = approved
      .map((r) => `${r.method} ${pathOf(r.url)} — ${r.purpose}${r.businessRules.length ? ` Rules: ${r.businessRules.join('; ')}` : ''}`)
      .join('\n');

    onApply({
      ...result.brief,
      requirements: `${result.brief.requirements}\n\n${rules}`.slice(0, 2000),
      focus: [...keep].slice(0, 8),
      outline: keptCriteria.flatMap((c) => c.testIdeas).slice(0, 8),
    }, [...keep]);
    toast.success('Strategy updated', `${approved.length} approved requirement${approved.length === 1 ? '' : 's'} · generation will follow this plan.`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FileText className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Story-driven generation</h3>
          <span className="text-[11px] text-gray-400">Jira story / PRD → a reviewed test plan</span>
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
              placeholder={'Paste the Jira story, PRD section, or acceptance criteria…\n\nPROJ-120  As a user I can reset my password so that I regain access.\n- Given a valid email, a reset link is sent.\n- An unknown email returns a generic 200.'}
              disabled={loading}
              className={`${INPUT} resize-y`}
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Each criterion is mapped to endpoints in your catalogue. An issue key in the text (PROJ-120) is looked up in Jira and your test-management tools to source the requirement.
            </p>
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

              {/* The checklist, rolled up across every endpoint the story reaches */}
              <div className={`${CARD} p-3`}>
                <div className="flex items-center gap-1.5 mb-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#7C3AED]" />
                  <p className="text-[12px] font-semibold text-gray-900">Readiness checklist</p>
                  <span className="text-[11px] text-gray-400">
                    {reqs.length} endpoint{reqs.length === 1 ? '' : 's'} · {approved.length} approved
                  </span>
                </div>
                {result.checklist.map((c) => (
                  <CheckRow
                    key={c.id}
                    item={c}
                    pass={c.id === 'reviewed' ? reqs.length > 0 && reviewed.length === reqs.length : undefined}
                    detail={c.id === 'reviewed' && reqs.length > 0
                      ? (reviewed.length === reqs.length
                        ? `All ${reqs.length} reviewed — ${approved.length} approved, ${reviewed.length - approved.length} rejected.`
                        : `${reviewed.length} of ${reqs.length} reviewed.`)
                      : undefined}
                  />
                ))}
              </div>

              {result.unmappedCriteria > 0 && (
                <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
                  <p className="text-[12px] text-amber-700 min-w-0">
                    {result.unmappedCriteria} cri{result.unmappedCriteria === 1 ? 'terion' : 'teria'} couldn&apos;t be tied to a catalogue endpoint.
                  </p>
                </div>
              )}

              {/* Per-endpoint requirements — the review surface */}
              {reqs.length > 0 && (
                <div className="space-y-2">
                  <p className={LABEL}>Requirements to review</p>
                  {reqs.map((r) => (
                    <RequirementCard
                      key={r.url}
                      req={r}
                      review={reviews[r.url]}
                      defaultOpen={reqs.length <= 3}
                      onReview={(state) => setReviews((prev) => {
                        const next = { ...prev };
                        if (state) next[r.url] = state; else delete next[r.url];
                        return next;
                      })}
                    />
                  ))}
                </div>
              )}

              {/* The criteria themselves */}
              <div className="space-y-2">
                <p className={LABEL}>Acceptance criteria</p>
                {result.criteria.map((c: AcceptanceCriterion) => (
                  <div key={c.id} className={`${CARD} p-3 space-y-2`}>
                    <div className="flex items-start gap-2">
                      <p className="text-[12px] text-gray-800 min-w-0 flex-1 break-words">{c.text}</p>
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${BRAND_CHIP}`}>
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
          <div className="border-t border-gray-100 p-3 flex items-center gap-3 flex-shrink-0">
            <p className="text-[11.5px] min-w-0 flex-1 break-words">
              {blocked
                ? <span className="text-gray-500">{blocked}</span>
                : envWarning
                  ? <span className="text-amber-700">{result.checklist.find((c) => c.id === 'signed-off')?.detail} The run can still be designed, but it will not pass a sign-off gate.</span>
                  : <span className="text-emerald-700">All four checks hold for {approved.length} approved requirement{approved.length === 1 ? '' : 's'}.</span>}
            </p>
            <button type="button" onClick={apply} disabled={!!blocked} className={PRIMARY_BTN}>
              Apply as run strategy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
