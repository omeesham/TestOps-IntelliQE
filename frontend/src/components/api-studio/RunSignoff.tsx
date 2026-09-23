/**
 * RunSignoff — a sign-off / review thread for one run.
 *
 * A teammate can approve, reject, mark needs-work, or comment on the run, each
 * with a note; the header shows the current decision. Collaboration only — it
 * records who signed off and changes no permissions, and sits beside the report
 * without touching the pipeline.
 */
import { useEffect, useState } from 'react';
import { Loader2, ThumbsUp, ThumbsDown, PencilRuler, MessageSquare, ShieldCheck } from 'lucide-react';
import { listApiRunReviews, addApiRunReview, type RunReview, type ReviewDecision } from '@/services/api';
import { relativeTime } from './format';

const DECISIONS: { id: ReviewDecision; label: string; icon: React.ElementType; cls: string }[] = [
  { id: 'approved', label: 'Approve', icon: ThumbsUp, cls: 'text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100' },
  { id: 'rejected', label: 'Reject', icon: ThumbsDown, cls: 'text-red-700 border-red-200 bg-red-50 hover:bg-red-100' },
  { id: 'needs_work', label: 'Needs work', icon: PencilRuler, cls: 'text-amber-700 border-amber-200 bg-amber-50 hover:bg-amber-100' },
  { id: 'comment', label: 'Comment', icon: MessageSquare, cls: 'text-gray-600 border-gray-200 bg-gray-50 hover:bg-gray-100' },
];

const STATUS_META: Record<Exclude<ReviewDecision, 'comment'>, { label: string; cls: string }> = {
  approved: { label: 'Approved', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  rejected: { label: 'Rejected', cls: 'text-red-700 bg-red-50 border-red-200' },
  needs_work: { label: 'Needs work', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
};

function decoOf(d: ReviewDecision) { return DECISIONS.find((x) => x.id === d)!; }

export default function RunSignoff({ runId }: { runId: string }) {
  const [reviews, setReviews] = useState<RunReview[]>([]);
  const [status, setStatus] = useState<ReviewDecision | null>(null);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<ReviewDecision>('approved');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try { const t = await listApiRunReviews(runId); setReviews(t.reviews); setStatus(t.status); }
    catch { /* a missing thread just shows the empty state */ }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (decision === 'comment' && !note.trim()) { setError('A comment needs some text.'); return; }
    setSaving(true); setError('');
    try {
      await addApiRunReview(runId, decision, note.trim() || undefined);
      setNote('');
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not save the review.');
    } finally { setSaving(false); }
  };

  const statusMeta = status && status !== 'comment' ? STATUS_META[status] : null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="w-3.5 h-3.5 text-gray-400" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Sign-off</h3>
        {statusMeta && <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${statusMeta.cls}`}>{statusMeta.label}</span>}
        {loading && <Loader2 className="w-3 h-3 animate-spin text-gray-300" />}
      </div>

      <div className="border border-[#E9E5FB] rounded-xl bg-gradient-to-b from-white to-[#FCFBFF] p-3 space-y-3">
        {/* Compose */}
        <div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {DECISIONS.map((d) => {
              const active = decision === d.id;
              return (
                <button key={d.id} type="button" onClick={() => { setDecision(d.id); setError(''); }}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11.5px] font-medium transition-colors ${active ? d.cls + ' ring-1 ring-inset ring-current/20' : 'text-gray-500 border-gray-200 bg-white hover:bg-gray-50'}`}>
                  <d.icon className="w-3.5 h-3.5" />{d.label}
                </button>
              );
            })}
          </div>
          <textarea
            value={note} onChange={(e) => { setNote(e.target.value); setError(''); }}
            rows={2} placeholder={decision === 'comment' ? 'Leave a comment…' : 'Add a note (optional)…'}
            className="w-full text-[12px] rounded-lg border border-gray-200 px-2.5 py-1.5 resize-y focus:outline-none focus:ring-2 focus:ring-[#A5B4FC] focus:border-[#A5B4FC] bg-white"
          />
          {error && <p className="text-[11px] text-red-600 mt-1">{error}</p>}
          <div className="flex justify-end mt-2">
            <button type="button" onClick={() => void submit()} disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-b from-[#8B5CF6] to-[#6D28D9] border border-[#6D28D9]/50 ring-1 ring-inset ring-white/20 hover:from-[#7C3AED] hover:to-[#5B21B6] disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <>{(() => { const D = decoOf(decision).icon; return <D className="w-3.5 h-3.5" />; })()}</>}
              Record {decoOf(decision).label.toLowerCase()}
            </button>
          </div>
        </div>

        {/* Thread */}
        {reviews.length > 0 && (
          <div className="border-t border-gray-100 pt-2.5 space-y-2">
            {reviews.map((r) => {
              const d = decoOf(r.decision);
              return (
                <div key={r.id} className="flex gap-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 border ${d.cls}`}><d.icon className="w-3 h-3" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[11.5px]">
                      <span className="font-medium text-gray-800">{r.reviewer || 'Someone'}</span>
                      <span className="text-gray-400">{d.label.toLowerCase()}</span>
                      <span className="text-gray-300">·</span>
                      <span className="text-gray-400">{relativeTime(r.createdAt)}</span>
                    </div>
                    {r.note && <p className="text-[12px] text-gray-600 mt-0.5 whitespace-pre-wrap break-words">{r.note}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
