/**
 * Loader — the app's larger, labelled wait indicator.
 *
 * Wraps the shared <Spinner /> (the single spinner used across the whole app)
 * with an optional label + hint, for the moments where a whole panel or page is
 * waiting. The spinner itself is identical to every inline spinner — only the
 * size and the accompanying text differ.
 *
 *   <Loader />                                    // just the ring
 *   <Loader label="Loading report" />             // ring + text (dots animate)
 *   <Loader size="lg" label="Designing scenarios" hint="Large catalogues take a minute or two" />
 *   <Loader.Block label="…" />                    // centred in a full-height area
 */
import Spinner from './Spinner';

type Size = 'sm' | 'md' | 'lg';

const BOX: Record<Size, string> = {
  sm: 'w-6 h-6',
  md: 'w-10 h-10',
  lg: 'w-14 h-14',
};

interface Props {
  size?: Size;
  label?: string;
  hint?: string;
  className?: string;
}

export default function Loader({ size = 'md', label, hint, className = '' }: Props) {
  return (
    <div className={`inline-flex flex-col items-center justify-center gap-3 ${className}`} role="status" aria-live="polite" aria-label={label || 'Loading'}>
      <Spinner className={`${BOX[size]} text-[#7C3AED]`} />
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
