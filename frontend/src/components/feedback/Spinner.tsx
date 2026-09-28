/**
 * Spinner — the single loading spinner for the whole app.
 *
 * One ring spinner everywhere: a rotating arc that inherits the current text
 * colour (`currentColor`), so it reads correctly on a light surface (where it
 * takes the brand violet from a `text-[#7C3AED]` wrapper) and on a coloured
 * button alike (where it takes the button's `text-white`). It is a drop-in for
 * the sizes lucide's `Loader2` was used at — pass the width/height (and an
 * optional text colour) through `className`, exactly as before.
 */
export default function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin ${className}`}
    />
  );
}
