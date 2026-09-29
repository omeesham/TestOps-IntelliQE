/**
 * API Studio — the stage rail.
 *
 * The run's spine, always on screen: which of the five stages is happening,
 * what each one produced, and how long it took. Before a stage runs it shows
 * what it is *for*, so the rail also explains the pipeline to someone seeing it
 * for the first time rather than being five empty labels. Once the run has
 * finished, a Push to repo control sits at the tail, just past Report.
 */
import { Check, X, Ban, GitBranch, ExternalLink, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { formatDuration, SECONDARY_3D, BRAND_BUTTON } from './format';
import type { Stage, PushState } from './types';

const LABEL_CLS: Record<Stage['status'], string> = {
  done: 'text-gray-800',
  running: 'text-[#6D28D9]',
  failed: 'text-red-600',
  skipped: 'text-gray-400',
  pending: 'text-gray-300',
};

function Marker({ status, index }: { status: Stage['status']; index: number }) {
  if (status === 'done') {
    return (
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-emerald-400 to-emerald-600 flex items-center justify-center ring-2 ring-white">
        <Check className="w-3 h-3 text-white" />
      </div>
    );
  }
  if (status === 'running') {
    return (
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-[#7C3AED] to-[#6D28D9] flex items-center justify-center ring-2 ring-white">
        <Spinner className="w-3 h-3 text-white animate-spin" />
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-red-400 to-red-600 flex items-center justify-center ring-2 ring-white">
        <X className="w-3 h-3 text-white" />
      </div>
    );
  }
  if (status === 'skipped') {
    return (
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-gray-100 to-gray-200 flex items-center justify-center ring-2 ring-white">
        <Ban className="w-2.5 h-2.5 text-gray-500" />
      </div>
    );
  }
  return (
    <div className="w-5 h-5 rounded-full border-2 border-gray-200 bg-white flex items-center justify-center">
      <span className="text-[9px] font-semibold text-gray-300">{index + 1}</span>
    </div>
  );
}

/**
 * The push-to-repo control that sits at the tail of the rail, right after
 * Report — the natural next step once a run has proved its specs. It is the
 * same action offered in the Report tab, surfaced on the spine so it is one
 * click away from wherever you are watching the run.
 */
function PushAction({ push }: { push: PushRailProps }) {
  const { pushState, canPush, onPushToRepo } = push;
  const pushing = pushState.status === 'pushing';

  // Once the push lands, the button becomes a link to what it produced.
  if (pushState.status === 'done') {
    return (
      <a
        href={pushState.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pushState.mode === 'pr' ? 'Pull request opened' : 'Committed'} on ${pushState.branch}${pushState.repo ? ` in ${pushState.repo}` : ''} · ${pushState.fileCount} file${pushState.fileCount === 1 ? '' : 's'}`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50 hover:text-[#7C3AED] transition-colors whitespace-nowrap"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        {pushState.mode === 'pr' ? 'View pull request' : 'View branch'}
      </a>
    );
  }

  // Error keeps the red retry signal; idle / pushing wear the green primary.
  if (pushState.status === 'error') {
    return (
      <button
        type="button"
        onClick={onPushToRepo}
        title={pushState.error}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold rounded-md transition-all whitespace-nowrap text-red-700 bg-gradient-to-b from-white to-[#FEF4F4] border border-red-200 hover:border-red-300 ${SECONDARY_3D}`}
      >
        <AlertTriangle className="w-3.5 h-3.5" />Retry push
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onPushToRepo}
      disabled={!canPush || pushing}
      title={canPush
        ? 'Commit the generated specs to the repository connected under System Configuration → Code Repositories'
        : 'There are no generated specs to push'}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-semibold text-white rounded-md transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${BRAND_BUTTON}`}
    >
      {pushing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
      {pushing ? 'Pushing…' : 'Push to repo'}
    </button>
  );
}

/** Everything the tail-of-rail push button needs. Optional so the rail can be
    rendered without it (e.g. before a run finishes wiring it up). */
export interface PushRailProps {
  onPushToRepo: () => void;
  pushState: PushState;
  /** False when the run produced no specs to push. */
  canPush: boolean;
  /** Only surface the control once the run has finished. */
  show: boolean;
}

export default function StageRail({ stages, push }: { stages: Stage[]; push?: PushRailProps }) {
  return (
    <div className="relative z-10 flex items-stretch bg-white rounded-2xl border border-gray-100 shadow-sm flex-shrink-0 overflow-hidden">
      {/* The five stages share the available width and compress to fit, so the
          push control at the tail is never pushed off-screen and the page never
          scrolls horizontally. Only if the window is extremely narrow do the
          stages themselves scroll — inside this group, not the page. */}
      <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto">
        {stages.map((s, i) => (
          <div
            key={s.key}
            className={`flex items-center gap-2 px-3 py-2 min-w-[128px] flex-1 border-r border-gray-100 last:border-r-0 transition-colors ${
              s.status === 'running'
                ? 'bg-purple-50'
                : ''
            }`}
            title={s.hint}
          >
            <div className="flex-shrink-0"><Marker status={s.status} index={i} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className={`text-[11.5px] font-semibold truncate ${LABEL_CLS[s.status]}`}>{s.label}</span>
                {s.durationMs !== undefined && (
                  <span className="font-mono text-[9.5px] text-gray-400 tabular-nums flex-shrink-0">{formatDuration(s.durationMs)}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Push to repo — a fixed sibling at the tail, just past Report, so it
          stays visible on the same screen no matter how narrow the rail gets. */}
      {push?.show && (
        <div className="flex items-center px-3 py-2 flex-shrink-0 border-l border-[#E9E5FB] bg-white">
          <PushAction push={push} />
        </div>
      )}
    </div>
  );
}
