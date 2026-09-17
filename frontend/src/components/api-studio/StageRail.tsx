/**
 * API Studio — the stage rail.
 *
 * The run's spine, always on screen: which of the five stages is happening,
 * what each one produced, and how long it took. Before a stage runs it shows
 * what it is *for*, so the rail also explains the pipeline to someone seeing it
 * for the first time rather than being five empty labels.
 */
import { Check, Loader2, X, Ban } from 'lucide-react';
import { formatDuration } from './format';
import type { Stage } from './types';

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
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-emerald-400 to-emerald-600 flex items-center justify-center ring-2 ring-white shadow-[0_2px_5px_-1px_rgba(16,185,129,0.55)]">
        <Check className="w-3 h-3 text-white" />
      </div>
    );
  }
  if (status === 'running') {
    return (
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-[#8B5CF6] to-[#6D28D9] flex items-center justify-center ring-2 ring-white shadow-[0_0_0_4px_rgba(124,58,237,0.15),0_2px_6px_-1px_rgba(124,58,237,0.6)]">
        <Loader2 className="w-3 h-3 text-white animate-spin" />
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-red-400 to-red-600 flex items-center justify-center ring-2 ring-white shadow-[0_2px_5px_-1px_rgba(239,68,68,0.55)]">
        <X className="w-3 h-3 text-white" />
      </div>
    );
  }
  if (status === 'skipped') {
    return (
      <div className="w-5 h-5 rounded-full bg-gradient-to-b from-gray-100 to-gray-200 flex items-center justify-center ring-2 ring-white shadow-[0_1px_3px_rgba(15,23,42,0.12)]">
        <Ban className="w-2.5 h-2.5 text-gray-500" />
      </div>
    );
  }
  return (
    <div className="w-5 h-5 rounded-full border-2 border-gray-200 bg-white flex items-center justify-center shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)]">
      <span className="text-[9px] font-semibold text-gray-300">{index + 1}</span>
    </div>
  );
}

export default function StageRail({ stages }: { stages: Stage[] }) {
  return (
    <div className="relative z-10 flex items-stretch bg-gradient-to-b from-white to-[#FCFBFF] border-b border-[#E9E5FB] flex-shrink-0 overflow-x-auto shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_6px_16px_-12px_rgba(76,29,149,0.45)]">
      {stages.map((s, i) => (
        <div
          key={s.key}
          className={`flex items-center gap-2 px-3 py-2 min-w-[190px] flex-1 border-r border-gray-100 last:border-r-0 transition-colors ${
            s.status === 'running'
              ? 'bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] shadow-[inset_0_2px_0_rgba(124,58,237,0.45),inset_0_-1px_0_rgba(255,255,255,0.8),0_4px_12px_-8px_rgba(76,29,149,0.45)]'
              : ''
          }`}
          title={s.hint}
        >
          <div className="flex-shrink-0"><Marker status={s.status} index={i} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className={`text-[11.5px] font-semibold ${LABEL_CLS[s.status]}`}>{s.label}</span>
              {s.durationMs !== undefined && (
                <span className="font-mono text-[9.5px] text-gray-400 tabular-nums">{formatDuration(s.durationMs)}</span>
              )}
            </div>
            <p className={`text-[10px] truncate ${s.status === 'pending' ? 'text-gray-300' : 'text-gray-500'}`}>
              {s.status === 'pending' ? s.hint : s.detail}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
