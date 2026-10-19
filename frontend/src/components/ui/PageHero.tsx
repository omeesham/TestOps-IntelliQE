import type { ReactNode } from 'react';

export interface HeroStat {
  label: string;
  value: ReactNode;
  /** Optional accent dot colour (e.g. the emerald/red outcome tones). */
  dot?: string;
}

/**
 * The page-level gradient hero banner — the same violet→indigo language as the
 * API Studio `TabHero`, scaled up to open a full page. An icon, a title, an
 * optional subtitle, an optional row of glass stat tiles and an optional
 * right-aligned actions slot. Purely presentational; works in light and dark
 * (the gradient reads as an accent on both).
 */
export default function PageHero({
  icon: Icon,
  title,
  subtitle,
  stats,
  actions,
  className = '',
}: {
  icon: React.ElementType;
  title: string;
  subtitle?: ReactNode;
  stats?: HeroStat[];
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#5B21B6] via-[#7C3AED] to-[#4338CA] px-6 py-5 shadow-[0_22px_52px_-24px_rgba(76,29,149,0.8)] ${className}`}
    >
      {/* glow orbs + dotted grid — the same depth cues as the studio hero */}
      <div className="pointer-events-none absolute -top-20 -right-10 w-64 h-64 rounded-full bg-[#E879F9]/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-12 w-64 h-64 rounded-full bg-[#22D3EE]/20 blur-3xl" />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '22px 22px' }}
      />

      <div className="relative flex items-center gap-4 flex-wrap">
        <span className="w-12 h-12 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center flex-shrink-0 backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
          <Icon className="w-6 h-6 text-white" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-white leading-tight tracking-tight truncate">{title}</h1>
          {subtitle != null && subtitle !== '' && (
            <p className="text-[12.5px] text-white/75 mt-0.5 truncate">{subtitle}</p>
          )}
        </div>

        {/* Stat tiles */}
        {stats && stats.length > 0 && (
          <div className="flex items-stretch gap-2.5 flex-shrink-0">
            {stats.map((s, i) => (
              <div
                key={i}
                className="min-w-[72px] rounded-xl bg-white/10 border border-white/20 px-3.5 py-2 backdrop-blur-sm"
              >
                <div className="flex items-center gap-1.5">
                  {s.dot && <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />}
                  <span className="text-lg font-bold text-white tabular-nums leading-none">{s.value}</span>
                </div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-white/60 mt-1">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
