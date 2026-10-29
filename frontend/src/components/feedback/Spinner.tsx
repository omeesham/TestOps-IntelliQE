/**
 * Spinner — the single loading indicator for the whole app.
 *
 * A "bars (wave)" equaliser: five rounded bars that rise and fall in a wave.
 * Drawn as a self-contained SVG so it scales crisply to whatever size the
 * caller asks for, and filled with `currentColor` so it reads correctly on a
 * light surface (where it takes the brand violet from a `text-[#7C3AED]`
 * wrapper) and on a coloured button alike (where it takes the button's
 * `text-white`). It is a drop-in for the sizes lucide's `Loader2` was used at —
 * pass the width/height (and an optional text colour) through `className`,
 * exactly as before.
 */

// x position of each bar in the 24×24 viewBox (3-wide bars, 1.5 gaps), paired
// with a negative animation offset so the wave is already in motion on mount.
// The offsets are symmetric (outer bars lead, centre trails) for a steady pulse.
const BARS = [
  { x: 1.5, begin: '0s' },
  { x: 6, begin: '-0.12s' },
  { x: 10.5, begin: '-0.24s' },
  { x: 15, begin: '-0.12s' },
  { x: 19.5, begin: '0s' },
];

export default function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      role="status"
      aria-label="Loading"
      viewBox="0 0 24 24"
      fill="currentColor"
      preserveAspectRatio="xMidYMid meet"
      className={`inline-block shrink-0 ${className}`}
    >
      {BARS.map((b, i) => (
        <rect key={i} x={b.x} y="8" width="3" height="8" rx="1.5">
          <animate
            attributeName="height"
            values="8;20;8"
            keyTimes="0;0.5;1"
            dur="0.9s"
            begin={b.begin}
            calcMode="spline"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
            repeatCount="indefinite"
          />
          <animate
            attributeName="y"
            values="8;2;8"
            keyTimes="0;0.5;1"
            dur="0.9s"
            begin={b.begin}
            calcMode="spline"
            keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
            repeatCount="indefinite"
          />
        </rect>
      ))}
    </svg>
  );
}
