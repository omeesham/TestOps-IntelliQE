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
import { useMemo, useRef, useState } from 'react';
import {
  FileText, X, AlertTriangle, Sparkles, CheckCircle2, XCircle, Link2,
  ChevronDown, ChevronRight, ShieldCheck, Undo2, Pencil, Save, Plus, Trash2, Upload, Download,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { useAuth } from '@/contexts/AuthContext';
import {
  generateFromStory,
  getJiraStories, getJiraStoryDetails, getAzureDevopsStories, getAzureDevopsStoryDetails, extractDocumentText,
  type StoryGenResult, type AcceptanceCriterion, type AttoBrief, type StoryOrigin,
  type EndpointRequirement, type ChecklistItem, type ReqSourceRef,
  type ReqClassification, type ReqInput, type ReqResponse, type ReqConflict,
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

/** The 5-state trust label, with the words and colour a person reads it by. */
const CLASS_META: Record<ReqClassification, { label: string; cls: string }> = {
  SOURCE_BACKED:   { label: 'Source-backed',   cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  INFERRED:        { label: 'Inferred',         cls: 'text-sky-700 bg-sky-50 border-sky-200' },
  REVIEW_REQUIRED: { label: 'Review required',  cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  CONFLICTING:     { label: 'Conflicting',      cls: 'text-rose-700 bg-rose-50 border-rose-200' },
  MISSING:         { label: 'Missing',          cls: 'text-gray-600 bg-gray-50 border-gray-200' },
};

/** The classification chip plus the reproducible confidence it was scored at. */
function ClassBadge({ req }: { req: EndpointRequirement }) {
  const m = CLASS_META[req.classification] ?? CLASS_META.REVIEW_REQUIRED;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${m.cls}`}
      title={`Confidence ${Math.round(req.confidence * 100)}% — decided from completeness, source strength and grounding`}
    >
      {req.classification === 'CONFLICTING' && <AlertTriangle className="w-3 h-3" />}
      {m.label}
      <span className="opacity-60">· {Math.round(req.confidence * 100)}%</span>
    </span>
  );
}

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

/** The four parts a reviewer may edit before a requirement is planned. */
type ReqEdit = Pick<EndpointRequirement, 'purpose' | 'inputs' | 'expectedResponses' | 'businessRules'>;

const PARAM_IN: ReqInput['in'][] = ['path', 'query', 'header', 'body'];
const CAPTURED_LABEL = 'Purpose, inputs, expected responses and business rules captured';

/** Does this endpoint take anything at all? Mirrors the backend `takesInputs`. */
function takesInputs(e?: CatalogEndpoint): boolean {
  return !!(e?.pathParams?.length || e?.queryParams?.length || (e?.body && e.body.trim()));
}

const normWhen = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Same condition → two statuses is a contradiction. Mirrors the backend scan. */
function responseConflicts(responses: ReqResponse[]): ReqConflict[] {
  const byWhen = new Map<string, Set<number>>();
  for (const r of responses) {
    const key = normWhen(r.when);
    if (!key) continue;
    (byWhen.get(key) || byWhen.set(key, new Set()).get(key)!).add(r.status);
  }
  const out: ReqConflict[] = [];
  for (const [, st] of byWhen) {
    if (st.size > 1) out.push({ summary: `The story asks for ${[...st].sort((a, b) => a - b).join(' and ')} on the same condition.`, origin: 'responses' });
  }
  return out;
}

/**
 * Recompute the captured check, classification, confidence and conflicts after a
 * reviewer edits a requirement — the same deterministic pass the backend runs,
 * with grounding treated as 1 because an edited field is human-stated, not
 * inferred. The source, reviewed and signed-off items are untouched: editing the
 * content changes neither provenance, the reviewer's decision, nor the
 * environment. Conflicts the model read in the story persist; response-level ones
 * are rescanned from the edited responses.
 */
function reevaluate(req: EndpointRequirement, endpoint?: CatalogEndpoint): EndpointRequirement {
  const needsInputs = takesInputs(endpoint);
  const missing: string[] = [];
  if (!req.purpose) missing.push('purpose');
  if (!req.inputs.length && needsInputs) missing.push('inputs');
  if (!req.expectedResponses.length) missing.push('expected responses');
  if (!req.businessRules.length) missing.push('business rules');

  const capturedItem: ChecklistItem = {
    id: 'captured', label: CAPTURED_LABEL, pass: missing.length === 0,
    detail: missing.length
      ? `Missing ${missing.join(', ')}.`
      : `${req.inputs.length} input${req.inputs.length === 1 ? '' : 's'}, ${req.expectedResponses.length} response${req.expectedResponses.length === 1 ? '' : 's'}, ${req.businessRules.length} rule${req.businessRules.length === 1 ? '' : 's'}.`,
  };
  const checklist = req.checklist.map((c) => (c.id === 'captured' ? capturedItem : c));

  const conflicts = [...responseConflicts(req.expectedResponses), ...req.conflicts.filter((c) => c.origin === 'model')]
    .filter((c, i, a) => a.findIndex((x) => normWhen(x.summary) === normWhen(c.summary)) === i)
    .slice(0, 6);

  const captured = [!!req.purpose, req.inputs.length > 0 || !needsInputs, req.expectedResponses.length > 0, req.businessRules.length > 0].filter(Boolean).length;
  const completeness = captured / 4;
  const hasVerified = req.sources.some((s) => s.verified);
  const hasAnySource = req.sources.length > 0;
  const sourceScore = hasVerified ? 1 : hasAnySource ? 0.5 : 0;
  const g = 1; // the reviewer stated it outright

  let classification: ReqClassification;
  if (conflicts.length) classification = 'CONFLICTING';
  else if (captured === 0) classification = 'MISSING';
  else if (captured <= 1) classification = 'REVIEW_REQUIRED';
  else if (hasVerified && captured >= 3) classification = 'SOURCE_BACKED';
  else if (!hasAnySource) classification = 'REVIEW_REQUIRED';
  else classification = 'INFERRED';

  let confidence = 0.45 * completeness + 0.3 * sourceScore + 0.25 * g;
  if (classification === 'CONFLICTING') confidence = Math.min(confidence, 0.4);
  if (classification === 'MISSING') confidence = Math.min(confidence, 0.15);
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

  const ready = checklist.filter((c) => c.id === 'captured' || c.id === 'source').every((c) => c.pass);
  return { ...req, checklist, classification, confidence, conflicts, ready };
}

function RequirementCard({
  req, review, onReview, onSaveEdit, endpoint, edited, defaultOpen,
}: {
  req: EndpointRequirement;
  review?: ReviewState;
  onReview: (state: ReviewState | undefined) => void;
  /** Persist a reviewer's edit to the four captured parts, then recompute. */
  onSaveEdit: (edit: ReqEdit) => void;
  /** The catalogue endpoint, for the "takes no inputs" case when recomputing. */
  endpoint?: CatalogEndpoint;
  /** True once this requirement has been edited in review. */
  edited?: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<ReqEdit | null>(null);
  const Chevron = open ? ChevronDown : ChevronRight;

  const startEdit = () => {
    setDraft({
      purpose: req.purpose,
      inputs: req.inputs.map((i) => ({ ...i })),
      expectedResponses: req.expectedResponses.map((r) => ({ ...r })),
      businessRules: [...req.businessRules],
    });
    setOpen(true);
  };
  const saveEdit = () => {
    if (!draft) return;
    onSaveEdit({
      purpose: draft.purpose.trim().slice(0, 200),
      inputs: draft.inputs.map((i) => ({ ...i, name: i.name.trim().slice(0, 80), note: i.note?.trim().slice(0, 120) || undefined })).filter((i) => i.name),
      expectedResponses: draft.expectedResponses.map((r) => ({ status: Number(r.status) || 0, when: String(r.when).trim().slice(0, 120) })).filter((r) => r.status >= 100 && r.status <= 599),
      businessRules: draft.businessRules.map((b) => b.trim().slice(0, 160)).filter(Boolean),
    });
    setDraft(null);
  };

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
        <ClassBadge req={req} />
        {edited && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium text-sky-700 bg-sky-50 border-sky-200 flex-shrink-0">Edited</span>}
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
          {/* The four captured parts — editable in review, read-only otherwise */}
          {draft ? (
            <ReqEditForm draft={draft} setDraft={setDraft} />
          ) : (
            <>
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
            </>
          )}

          <div>
            <p className={LABEL}>Source</p>
            {req.sources.length === 0
              ? <p className="text-[11.5px] text-rose-600">Nothing to trace this back to.</p>
              : <div className="flex flex-wrap gap-1.5">{req.sources.map((s, n) => <SourceChip key={n} s={s} />)}</div>}
          </div>

          {/* Conflicts — why a requirement reads as CONFLICTING, stated plainly */}
          {req.conflicts.length > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 mb-1">
                <AlertTriangle className="w-3.5 h-3.5" /> Conflicting requirement
              </p>
              <ul className="list-disc list-inside space-y-0.5">
                {req.conflicts.map((c, n) => (
                  <li key={n} className="text-[11.5px] text-rose-800 break-words">
                    {c.summary}
                    <span className="text-rose-400 ml-1">({c.origin === 'responses' ? 'from the responses' : 'stated in the story'})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

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

          {/* The reviewer's decision — edit, then approve or reject (item 3) */}
          <div className="flex items-center gap-2">
            {draft ? (
              <>
                <button type="button" onClick={saveEdit} className={PRIMARY_BTN}>
                  <Save className="w-3.5 h-3.5" /> Save changes
                </button>
                <button type="button" onClick={() => setDraft(null)} className={SECONDARY_BTN}>
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              </>
            ) : review ? (
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
                <button type="button" onClick={startEdit} className={SECONDARY_BTN}>
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The reviewer's edit surface for one requirement's four captured parts. */
function ReqEditForm({ draft, setDraft }: { draft: ReqEdit; setDraft: (d: ReqEdit) => void }) {
  const up = (patch: Partial<ReqEdit>) => setDraft({ ...draft, ...patch });
  const addBtn = 'inline-flex items-center gap-1 text-[11px] text-[#7C3AED] hover:underline';
  const rmBtn = 'p-1 text-gray-300 hover:text-rose-500 flex-shrink-0';

  return (
    <div className="space-y-3">
      <div>
        <label className={LABEL}>Purpose</label>
        <textarea
          value={draft.purpose}
          onChange={(e) => up({ purpose: e.target.value })}
          rows={2}
          placeholder="What this endpoint is for in this story."
          className={`${INPUT} resize-y`}
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className={LABEL}>Inputs</label>
          <button type="button" className={addBtn} onClick={() => up({ inputs: [...draft.inputs, { name: '', in: 'body', required: false }] })}>
            <Plus className="w-3 h-3" /> Add input
          </button>
        </div>
        {draft.inputs.length === 0 && <p className="text-[11px] text-gray-400">None — add one if the endpoint takes any.</p>}
        <div className="space-y-1.5">
          {draft.inputs.map((i, n) => (
            <div key={n} className="flex items-center gap-1.5">
              <input value={i.name} onChange={(e) => up({ inputs: draft.inputs.map((x, k) => (k === n ? { ...x, name: e.target.value } : x)) })} placeholder="field" className={`${INPUT} font-mono flex-1 min-w-0`} />
              <select value={i.in} onChange={(e) => up({ inputs: draft.inputs.map((x, k) => (k === n ? { ...x, in: e.target.value as ReqInput['in'] } : x)) })} className={`${INPUT} w-[76px] flex-shrink-0`}>
                {PARAM_IN.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <label className="flex items-center gap-1 text-[10.5px] text-gray-500 flex-shrink-0">
                <input type="checkbox" checked={i.required} onChange={(e) => up({ inputs: draft.inputs.map((x, k) => (k === n ? { ...x, required: e.target.checked } : x)) })} className="w-3 h-3 rounded border-gray-300 text-[#7C3AED]" />
                req
              </label>
              <input value={i.note || ''} onChange={(e) => up({ inputs: draft.inputs.map((x, k) => (k === n ? { ...x, note: e.target.value } : x)) })} placeholder="note" className={`${INPUT} flex-[1.3] min-w-0`} />
              <button type="button" className={rmBtn} onClick={() => up({ inputs: draft.inputs.filter((_, k) => k !== n) })}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className={LABEL}>Expected responses</label>
          <button type="button" className={addBtn} onClick={() => up({ expectedResponses: [...draft.expectedResponses, { status: 200, when: '' }] })}>
            <Plus className="w-3 h-3" /> Add response
          </button>
        </div>
        {draft.expectedResponses.length === 0 && <p className="text-[11px] text-rose-500">Add at least one — success and the error statuses the story implies.</p>}
        <div className="space-y-1.5">
          {draft.expectedResponses.map((r, n) => (
            <div key={n} className="flex items-center gap-1.5">
              <input type="number" value={r.status || ''} onChange={(e) => up({ expectedResponses: draft.expectedResponses.map((x, k) => (k === n ? { ...x, status: Number(e.target.value) } : x)) })} placeholder="200" className={`${INPUT} font-mono w-[72px] flex-shrink-0`} />
              <input value={r.when} onChange={(e) => up({ expectedResponses: draft.expectedResponses.map((x, k) => (k === n ? { ...x, when: e.target.value } : x)) })} placeholder="the condition that produces it" className={`${INPUT} flex-1 min-w-0`} />
              <button type="button" className={rmBtn} onClick={() => up({ expectedResponses: draft.expectedResponses.filter((_, k) => k !== n) })}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className={LABEL}>Business rules</label>
          <button type="button" className={addBtn} onClick={() => up({ businessRules: [...draft.businessRules, ''] })}>
            <Plus className="w-3 h-3" /> Add rule
          </button>
        </div>
        {draft.businessRules.length === 0 && <p className="text-[11px] text-gray-400">None — add a rule the endpoint must honour.</p>}
        <div className="space-y-1.5">
          {draft.businessRules.map((b, n) => (
            <div key={n} className="flex items-center gap-1.5">
              <input value={b} onChange={(e) => up({ businessRules: draft.businessRules.map((x, k) => (k === n ? e.target.value : x)) })} placeholder="a rule stated so it can be tested" className={`${INPUT} flex-1 min-w-0`} />
              <button type="button" className={rmBtn} onClick={() => up({ businessRules: draft.businessRules.filter((_, k) => k !== n) })}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function StoryGen({
  endpoints, environment, onApply, onClose, onMineEndpoints,
}: {
  endpoints: CatalogEndpoint[];
  /** The environment the run would target — decides the customer-similar check. */
  environment?: ApiEnvironment | null;
  /** `approvedUrls` is what survived review — the caller narrows the run to it. */
  onApply: (brief: AttoBrief, approvedUrls: string[]) => void;
  onClose: () => void;
  /** Mine endpoints from an uploaded requirement document into the catalogue. */
  onMineEndpoints?: (file: File) => Promise<{ added: number; duplicates: number; total: number }>;
}) {
  const toast = useToast();
  const [story, setStory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StoryGenResult | null>(null);
  const [reqs, setReqs] = useState<EndpointRequirement[]>([]);
  const [edited, setEdited] = useState<Record<string, true>>({});
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({});

  /**
   * Catalogue endpoint by requirement ref (`METHOD url`), so a saved edit can
   * recompute the captured check against the right endpoint — the url alone is
   * ambiguous when a path has both a GET and a POST.
   */
  const endpointByRef = useMemo(
    () => new Map(endpoints.map((e) => [`${(e.method || 'GET').toUpperCase()} ${e.url}`, e])),
    [endpoints],
  );

  // ── Load the requirement from a connected tool or an uploaded document ──
  const { user } = useAuth();
  const username = user?.username || 'admin';
  const [origin, setOrigin] = useState<StoryOrigin | null>(null);
  const [picker, setPicker] = useState<null | 'jira' | 'ado'>(null);
  const [pickerItems, setPickerItems] = useState<{ key: string; summary: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [mining, setMining] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Open the Jira / ADO list (lazy — only hit the tool when the user asks). */
  const openPicker = async (kind: 'jira' | 'ado') => {
    if (picker === kind) { setPicker(null); return; }
    setPicker(kind);
    setPickerItems([]);
    setPicking(true);
    try {
      const items = kind === 'jira'
        ? (await getJiraStories(username) as { key: string; summary: string }[])
        : await getAzureDevopsStories();
      setPickerItems((items || []).map((i) => ({ key: String(i.key), summary: String(i.summary || '') })));
    } catch {
      const tool = kind === 'jira' ? 'Jira' : 'Azure DevOps';
      toast.error(`Could not reach ${tool}`, 'Connect it under Integrations, then try again.');
      setPicker(null);
    } finally {
      setPicking(false);
    }
  };

  /** Pull one story/work item in and prefill the box, recording its origin. */
  const loadItem = async (kind: 'jira' | 'ado', key: string) => {
    if (!key) return;
    setImporting(true);
    try {
      const d = kind === 'jira' ? await getJiraStoryDetails(username, key) : await getAzureDevopsStoryDetails(key);
      const ref = String(d.key || key);
      const parts = [
        // Prepend the Jira key so text-scan traceability resolves it even without the origin.
        kind === 'jira' ? ref : '',
        String(d.title || ''),
        d.description ? `\n${d.description}` : '',
        d.acceptanceCriteria ? `\nAcceptance Criteria:\n${d.acceptanceCriteria}` : '',
      ].filter(Boolean);
      setStory(parts.join('\n').trim().slice(0, 8000));
      setOrigin({ kind, ref, label: kind === 'jira' ? 'Jira' : 'Azure DevOps' });
      setPicker(null);
    } catch (err: any) {
      toast.fromError(err);
    } finally {
      setImporting(false);
    }
  };

  /**
   * One-stop document upload: extract the requirement text to prefill the box,
   * AND (when the caller wired it) mine the same file for endpoints into the
   * catalogue — so a BRD/FRD gives both the requirement and the APIs to map it to.
   */
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again later
    if (!file) return;
    setImporting(true);
    try {
      const doc = await extractDocumentText(file);
      if (!doc.text?.trim()) { toast.error('Nothing to read', 'That document had no extractable text.'); setImporting(false); return; }
      setStory(doc.text.slice(0, 8000));
      setOrigin({ kind: 'document', ref: doc.fileName || file.name, label: 'Document' });
      if (doc.warning) toast.info('Read with a caveat', doc.warning);
    } catch (err: any) {
      toast.fromError(err);
      setImporting(false);
      return;
    }
    setImporting(false);

    // Best-effort endpoint mining from the same document — never blocks the story.
    if (onMineEndpoints) {
      setMining(true);
      try {
        const { added, total } = await onMineEndpoints(file);
        if (total === 0) toast.info('No endpoints in the document', 'The requirement was loaded; it describes no API endpoints to add.');
        else if (added === 0) toast.info('Endpoints already in your catalogue', `${total} found in the document — all already imported.`);
        else toast.success(`${added} endpoint${added === 1 ? '' : 's'} added`, added < total ? `${total - added} were already in the catalogue.` : 'Mined from the document into your catalogue.');
      } catch {
        // The requirement text still loaded; mining is a bonus, so stay quiet on failure.
      } finally {
        setMining(false);
      }
    }
  };

  const run = async () => {
    const text = story.trim();
    if (!text || loading) return;
    setLoading(true);
    setError('');
    setReviews({});
    setReqs([]);
    setEdited({});
    try {
      const res = await generateFromStory({
        story: text,
        endpoints: endpoints.map((e) => ({
          method: e.method, url: e.url, title: e.title, operationId: e.operationId,
          description: e.description, source: e.source,
          pathParams: e.pathParams, queryParams: e.queryParams, body: e.body,
        })),
        environment: environment ? { id: environment.id, name: environment.name, customerLike: !!environment.customerLike } : null,
        origin: origin || undefined,
      });
      setResult(res);
      setReqs(res.endpointRequirements);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not generate a plan from the story.');
    } finally {
      setLoading(false);
    }
  };

  const approved = useMemo(() => reqs.filter((r) => reviews[r.ref] === 'approved'), [reqs, reviews]);
  const reviewed = useMemo(() => reqs.filter((r) => reviews[r.ref]), [reqs, reviews]);

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

            {/* Pull the requirement in from a connected tool or an uploaded document */}
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <span className="text-[11px] text-gray-400">Load from</span>
              {(['jira', 'ado'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={loading || importing || mining}
                  onClick={() => void openPicker(k)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] disabled:opacity-50 ${
                    picker === k ? 'bg-[#F5F3FF] border-[#C4B5FD] text-[#7C3AED]' : 'text-gray-600 border-gray-200 hover:border-[#C4B5FD] hover:text-[#7C3AED]'
                  }`}
                >
                  <Download className="w-3 h-3" /> {k === 'jira' ? 'Jira' : 'Azure DevOps'}
                </button>
              ))}
              <button
                type="button"
                disabled={loading || importing || mining}
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] text-gray-600 border-gray-200 hover:border-[#C4B5FD] hover:text-[#7C3AED] disabled:opacity-50"
              >
                <Upload className="w-3 h-3" /> Document
              </button>
              <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt,.md,.markdown,.xlsx,.xls,.csv" className="hidden" onChange={onFile} />
              {importing && <Spinner className="w-3.5 h-3.5 animate-spin text-[#7C3AED]" />}
              {mining && <span className="inline-flex items-center gap-1 text-[11px] text-[#7C3AED]"><Spinner className="w-3 h-3 animate-spin" /> Mining endpoints…</span>}
              {origin && (
                <span className="inline-flex items-center gap-1 max-w-[280px] px-1.5 py-0.5 rounded border text-[10.5px] text-[#7C3AED] bg-[#F5F3FF] border-[#DDD6FE]">
                  <Link2 className="w-3 h-3 flex-shrink-0" />
                  <span className="font-medium flex-shrink-0">{origin.label}</span>
                  <span className="text-[#A5B4FC]">·</span>
                  <span className="font-mono truncate">{origin.ref}</span>
                  <button type="button" onClick={() => setOrigin(null)} className="text-[#A5B4FC] hover:text-[#7C3AED] flex-shrink-0"><X className="w-3 h-3" /></button>
                </span>
              )}
            </div>

            {picker && (
              <div className="mb-1.5 rounded-lg border border-[#EDE9FE] bg-[#FAF9FE] p-2">
                {picking ? (
                  <div className="flex items-center gap-2 text-[11.5px] text-gray-500"><Spinner className="w-3.5 h-3.5 animate-spin" /> Loading {picker === 'jira' ? 'Jira stories' : 'work items'}…</div>
                ) : pickerItems.length === 0 ? (
                  <p className="text-[11.5px] text-gray-500">No items found — connect {picker === 'jira' ? 'Jira' : 'Azure DevOps'} under System Configuration → Integrations.</p>
                ) : (
                  <select defaultValue="" onChange={(e) => void loadItem(picker, e.target.value)} className={INPUT}>
                    <option value="" disabled>Select a {picker === 'jira' ? 'story' : 'work item'}… ({pickerItems.length})</option>
                    {pickerItems.map((it) => <option key={it.key} value={it.key}>{it.key} — {it.summary}</option>)}
                  </select>
                )}
              </div>
            )}

            <textarea
              value={story}
              onChange={(e) => setStory(e.target.value)}
              rows={8}
              placeholder={'Paste the Jira story, PRD section, or acceptance criteria…\n\nPROJ-120  As a user I can reset my password so that I regain access.\n- Given a valid email, a reset link is sent.\n- An unknown email returns a generic 200.'}
              disabled={loading}
              className={`${INPUT} resize-y`}
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Paste it, or load it from Jira, Azure DevOps or a BRD/FRD document — a document also has any endpoints it describes mined into your catalogue. Each criterion is mapped to those endpoints, and the loaded source (or an issue key like PROJ-120 in the text) is verified to trace every requirement back.
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
                {result.checklist.map((c) => {
                  // `reviewed` and `captured` are recomputed live: review is a UI
                  // action, and an edit can fill a gap the backend flagged.
                  const capturedMiss = reqs.filter((r) => !r.checklist.find((x) => x.id === 'captured')?.pass).length;
                  return (
                    <CheckRow
                      key={c.id}
                      item={c}
                      pass={c.id === 'reviewed'
                        ? reqs.length > 0 && reviewed.length === reqs.length
                        : c.id === 'captured'
                          ? reqs.length > 0 && capturedMiss === 0
                          : undefined}
                      detail={c.id === 'reviewed' && reqs.length > 0
                        ? (reviewed.length === reqs.length
                          ? `All ${reqs.length} reviewed — ${approved.length} approved, ${reviewed.length - approved.length} rejected.`
                          : `${reviewed.length} of ${reqs.length} reviewed.`)
                        : c.id === 'captured' && reqs.length > 0
                          ? (capturedMiss === 0
                            ? `Holds for all ${reqs.length} endpoint${reqs.length === 1 ? '' : 's'}.`
                            : `${capturedMiss} of ${reqs.length} still missing a part.`)
                          : undefined}
                    />
                  );
                })}
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
                      key={r.ref}
                      req={r}
                      review={reviews[r.ref]}
                      endpoint={endpointByRef.get(r.ref)}
                      edited={!!edited[r.ref]}
                      defaultOpen={reqs.length <= 3}
                      onReview={(state) => setReviews((prev) => {
                        const next = { ...prev };
                        if (state) next[r.ref] = state; else delete next[r.ref];
                        return next;
                      })}
                      onSaveEdit={(edit) => {
                        setReqs((prev) => prev.map((x) => (x.ref === r.ref ? reevaluate({ ...x, ...edit }, endpointByRef.get(r.ref)) : x)));
                        setEdited((prev) => ({ ...prev, [r.ref]: true }));
                      }}
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
