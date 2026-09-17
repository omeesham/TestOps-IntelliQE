/**
 * Loader — the one loading indicator for the app's larger waits.
 *
 * A thin violet track, a gradient arc that sweeps around it, and a soft
 * breathing core — simple enough to sit anywhere, distinctive enough to read
 * as IntelliQE. Button-sized waits keep lucide's `Loader2`; this is for the
 * moments where a whole panel or page is waiting.
 *
 *   <Loader />                                    // just the ring
 *   <Loader label="Loading report" />             // ring + text (dots animate)
 *   <Loader size="lg" label="Designing scenarios" hint="Large catalogues take a minute or two" />
 *   <Loader.Block label="…" />                    // centred in a full-height area
 */

type Size = 'sm' | 'md' | 'lg';

const RING: Record<Size, { box: string; border: string; core: string }> = {
  sm: { box: 'w-6 h-6', border: 'border-2', core: 'inset-[34%]' },
  md: { box: 'w-10 h-10', border: 'border-[3px]', core: 'inset-[32%]' },
  lg: { box: 'w-14 h-14', border: 'border-4', core: 'inset-[30%]' },
};

interface Props {
  size?: Size;
  label?: string;
  hint?: string;
  className?: string;
}

export default function Loader({ size = 'md', label, hint, className = '' }: Props) {
  const r = RING[size];
  return (
    <div className={`inline-flex flex-col items-center justify-center gap-3 ${className}`} role="status" aria-live="polite" aria-label={label || 'Loading'}>
      <div className={`relative ${r.box}`}>
        {/* track — recessed so the arc reads as riding in a groove */}
        <div className={`absolute inset-0 rounded-full ${r.border} border-[#EDE9FE] shadow-[inset_0_1px_2px_rgba(30,27,75,0.10)]`} />
        {/* sweeping arc — violet → indigo, with a soft glow */}
        <div
          className={`absolute inset-0 rounded-full ${r.border} border-transparent border-t-[#7C3AED] border-r-[#8B5CF6] animate-spin`}
          style={{ animationDuration: '0.9s', animationTimingFunction: 'cubic-bezier(0.45, 0.05, 0.55, 0.95)', filter: 'drop-shadow(0 0 4px rgba(124,58,237,0.45))' }}
        />
        {/* breathing core */}
        <div
          className={`absolute ${r.core} rounded-full bg-gradient-to-br from-[#8B5CF6] to-[#6366F1] shadow-[0_2px_8px_-2px_rgba(124,58,237,0.7),inset_0_1px_0_rgba(255,255,255,0.45)]`}
          style={{ animation: 'iq-breathe 1.6s ease-in-out infinite' }}
        />
      </div>
      {label && (
        <div className="text-center">
          <p className={`font-medium text-gray-700 ${size === 'lg' ? 'text-[13.5px]' : size === 'sm' ? 'text-[11.5px]' : 'text-[12.5px]'}`}>
            {label}
            <span className="inline-flex w-5 justify-start" aria-hidden>
              <span className="animate-pulse [animation-delay:0ms]">.</span>
              <span className="animate-pulse [animation-delay:200ms]">.</span>
              <span className="animate-pulse [animation-delay:400ms]">.</span>
            </span>
          </p>
          {hint && <p className="mt-1 text-[11px] text-gray-400 max-w-sm leading-relaxed">{hint}</p>}
        </div>
      )}
      <style>{`@keyframes iq-breathe { 0%, 100% { transform: scale(0.85); opacity: 0.75 } 50% { transform: scale(1); opacity: 1 } }`}</style>
    </div>
  );
}

/** The loader centred in whatever height its parent gives it. */
function Block({ minHeight = 240, ...props }: Props & { minHeight?: number | string }) {
  return (
    <div className="w-full h-full flex items-center justify-center" style={{ minHeight }}>
      <Loader {...props} />
    </div>
  );
}
Loader.Block = Block;
