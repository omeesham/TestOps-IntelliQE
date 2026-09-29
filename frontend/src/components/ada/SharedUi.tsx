/**
 * Small components shared by the ADA Compliance page, its drawers and the
 * report: the health ring, severity chips and the schedule cadence picker.
 */
import type { AdaSeverity } from '@/services/api';
import { SEVERITIES, SEV_LABEL, SEV_STYLE, WEEKDAYS, hourLabel, scoreHex } from '@/components/ada/shared';

/** Health score as a ring. A score that was never measured shows a dash, not a zero. */
export function HealthRing({ score, size = 44, stroke = 5, label, bare }: { score: number | null | undefined; size?: number; stroke?: number; label?: string; /** Ring only, when the number is shown next to it. */ bare?: boolean }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = ((score ?? 0) / 100) * circ;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} title={score == null ? 'Not scored' : `Health ${score} of 100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#EDE9FE" strokeWidth={stroke} fill="none" />
        {score != null && <circle cx={size / 2} cy={size / 2} r={r} stroke={scoreHex(score)} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${dash} ${circ - dash}`} />}
      </svg>
      {!bare && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-bold leading-none tabular-nums" style={{ fontSize: size / 3.1, color: score == null ? '#9CA3AF' : scoreHex(score) }}>{score ?? '—'}</span>
          {label && <span className="text-[10px] text-gray-400 mt-0.5">{label}</span>}
        </div>
      )}
    </div>
  );
}

export function SeverityChips({ counts }: { counts: Record<AdaSeverity, number> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {SEVERITIES.map((s) => (
        <span key={s} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap ${counts[s] > 0 ? SEV_STYLE[s] : 'bg-white text-gray-400 border-gray-200'}`}>
          <span className="tabular-nums">{counts[s].toLocaleString()}</span> {SEV_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

/** Cadence picker shared by the new-audit and new-schedule drawers. */
export function CadenceFields({ frequency, weekday, hour, onChange }: {
  frequency: 'daily' | 'weekly'; weekday: number; hour: number;
  onChange: (patch: { frequency?: 'daily' | 'weekly'; weekday?: number; hour?: number }) => void;
}) {
  const select = 'px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400';
  return (
    <div className="space-y-3">
      <div className="inline-flex p-0.5 bg-gray-100 rounded-lg">
        {(['weekly', 'daily'] as const).map((f) => (
          <button key={f} type="button" onClick={() => onChange({ frequency: f })} className={`px-4 py-1.5 text-xs font-medium rounded-md ${frequency === f ? 'bg-white text-violet-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            {f === 'weekly' ? 'Weekly' : 'Daily'}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
        {frequency === 'weekly' ? (
          <>
            <span>Every</span>
            <select value={weekday} onChange={(e) => onChange({ weekday: Number(e.target.value) })} className={select} aria-label="Day of the week">
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
            <span>at</span>
          </>
        ) : <span>Every day at</span>}
        <select value={hour} onChange={(e) => onChange({ hour: Number(e.target.value) })} className={select} aria-label="Time of day, local time">
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </select>
      </div>
    </div>
  );
}
