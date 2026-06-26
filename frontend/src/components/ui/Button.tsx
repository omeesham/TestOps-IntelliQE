import { forwardRef } from 'react';
import { twMerge } from 'tailwind-merge';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  isLoading?: boolean;
  /** Optional leading icon element (e.g. <Zap className="w-4 h-4" />) */
  leftIcon?: React.ReactNode;
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all ' +
  'focus:outline-none focus:ring-2 focus:ring-[#155dfc]/30 disabled:cursor-not-allowed';

const VARIANTS: Record<Variant, string> = {
  // Solid brand blue — standardized hover + disabled states.
  primary:
    'text-white bg-[#155dfc] shadow-lg shadow-blue-500/25 ' +
    'hover:bg-[#124fd6] hover:shadow-blue-500/40 ' +
    'disabled:bg-[#A8C4FB] disabled:shadow-none',
  secondary:
    'text-[#1E1B4B] bg-white border border-[#C9DCFF] hover:bg-[#EFF5FF] hover:border-[#93B4FB] ' +
    'disabled:opacity-50',
  ghost:
    'text-[#6B7280] bg-transparent hover:bg-[#EFF5FF] hover:text-[#155dfc] disabled:opacity-50',
  danger:
    'text-white bg-[#EF4444] hover:bg-[#DC2626] shadow-lg shadow-red-500/20 disabled:opacity-50',
};

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-2 text-xs',
  md: 'px-4 py-2.5 text-sm',
  lg: 'px-5 py-3.5 text-sm',
};

const Spinner = () => (
  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
);

/**
 * Shared button — single source of truth for button styling across the app.
 * Replaces the ad-hoc inline gradient buttons scattered through the pages.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', isLoading = false, leftIcon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      className={twMerge(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {isLoading ? <Spinner /> : leftIcon}
      {children}
    </button>
  );
});

export default Button;
