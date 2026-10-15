/**
 * API Studio — shared visual primitives.
 *
 * The studio is dense by design: an engineer scanning 20 scenarios and 20 run
 * rows needs the method, the category and the outcome legible at a glance and
 * in the same place every time. These are the pieces that keep that consistent,
 * so no panel invents its own colour for "failed" or its own shape for a chip.
 */
import { useState, type ReactNode } from 'react';
import { ChevronRight, Copy, Check } from 'lucide-react';
import { methodColor, categoryMeta, CHIP_3D } from './format';

/* ── HTTP method ────────────────────────────────────────────────────────── */

export function MethodBadge({ method, className = '' }: { method: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded border font-mono text-[10px] font-bold tracking-tight ${CHIP_3D} ${methodColor(method)} ${className}`}
    >
      {(method || '').toUpperCase()}
    </span>
  );
}

/* ── Scenario category ──────────────────────────────────────────────────── */

/**
 * The generator's `type` is a coverage category — the reader is scanning for
 * "is my error handling covered?", so it is labelled that way rather than by
 * the raw enum value.
 */
export function CategoryChip({ type }: { type: string }) {
  const m = categoryMeta(type);
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${CHIP_3D} ${m.cls}`}>
      {m.label}
    </span>
  );
}

/* ── Priority ───────────────────────────────────────────────────────────── */

/**
 * Priority is a severity, so the top two keep the app's alert colours; the rest
 * fall back to the standard violet chip rather than inventing a blue.
 */
const PRIORITY_CLS: Record<string, string> = {
  P0: 'text-red-600 bg-red-50',
  P1: 'text-amber-700 bg-amber-50',
  P2: 'text-[#6D28D9] bg-[#F5F3FF]',
  P3: 'text-[#6B7280] bg-gray-100',
};

export function PriorityChip({ priority }: { priority: string }) {
  const p = (priority || 'P1').toUpperCase();
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold ${CHIP_3D} ${PRIORITY_CLS[p] || PRIORITY_CLS.P2}`}>
      {p}
    </span>
  );
}

/* ── Status ─────────────────────────────────────────────────────────────── */

/** Outcome is the one thing colour still encodes — green / red, as everywhere else. */
const STATUS_META: Record<string, { label: string; dot: string; cls: string }> = {
  passed: { label: 'Passed', dot: 'bg-emerald-500', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  failed: { label: 'Failed', dot: 'bg-red-500', cls: 'text-red-700 bg-red-50 border-red-200' },
  running: { label: 'Running', dot: 'bg-[#7C3AED] animate-pulse', cls: 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]' },
  pending: { label: 'Queued', dot: 'bg-gray-300', cls: 'text-[#6B7280] bg-gray-50 border-gray-200' },
  not_run: { label: 'Not run', dot: 'bg-gray-400', cls: 'text-[#6B7280] bg-gray-100 border-gray-200' },
};

export function StatusPill({ status }: { status: string }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${CHIP_3D} ${m.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

/* ── HTTP status code ───────────────────────────────────────────────────── */

/**
 * Colour an expected/observed status by its class — 2xx green, 4xx amber,
 * 5xx red. These are outcomes, so they keep the alert colours; a 3xx is neither
 * and takes the standard violet chip.
 */
export function StatusCode({ code }: { code: string | number }) {
  const text = String(code ?? '').trim();
  const first = /(\d)/.exec(text)?.[1];
  const cls =
    first === '2' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : first === '3' ? 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]'
    : first === '4' ? 'text-amber-700 bg-amber-50 border-amber-200'
    : first === '5' ? 'text-red-700 bg-red-50 border-red-200'
    : 'text-[#6B7280] bg-gray-50 border-gray-200';
  if (!text) return <span className="text-gray-300">—</span>;
  return (
    <span className={`inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded border font-mono text-[11px] font-semibold ${CHIP_3D} ${cls}`}>
      {text}
    </span>
  );
}

/* ── Required-field marker ───────────────────────────────────── */

/**
 * The asterisk every mandatory field carries. One component so the glyph,
 * colour and spacing cannot drift between the URL bar, a section header and a
 * field label — and so assistive tech hears "required" rather than an
 * unexplained star.
 */
export function RequiredMark({ className = '' }: { className?: string }) {
  return (
    <span className={`text-red-400 ${className}`} title="Required" aria-label="required">
      *
    </span>
  );
}

/* ── Collapsible section (request panel) ────────────────────────────────── */

export function Section({
  title,
  badge,
  required = false,
  defaultOpen = true,
  children,
  action,
}: {
  title: string;
  /** Short right-aligned summary shown while collapsed AND open — e.g. "2", "Bearer". */
  badge?: ReactNode;
  /** Marks the section required — the asterisk stays visible when collapsed. */
  required?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left group"
        >
          <ChevronRight className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide group-hover:text-[#7C3AED] transition-colors">
            {title}
            {required && <RequiredMark className="ml-0.5" />}
          </span>
          {badge !== undefined && badge !== null && badge !== '' && (
            <span className="ml-auto text-[10px] font-medium text-gray-400 truncate max-w-[90px]">{badge}</span>
          )}
        </button>
        {action}
      </div>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
}

/* ── Code / JSON display ────────────────────────────────────────────────── */

/**
 * Minimal token colouring for the code and JSON panes. A full syntax
 * highlighter is a dependency and a bundle cost for what is, here, read-only
 * text an engineer skims — strings, keywords, numbers and comments are the
 * distinctions that actually carry meaning in a request spec.
 */
function highlight(code: string): string {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // One pass, alternation-ordered so a match inside a string or comment can't
  // be re-tokenised: comments and strings win before keywords and numbers.
  return escaped.replace(
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|const|let|var|async|await|function|return|if|else|throw|new|try|catch|export|default|true|false|null|undefined)\b|\b(\d+(?:\.\d+)?)\b/g,
    (_m, comment, str, kw, num) => {
      if (comment) return `<span class="text-gray-400 italic">${comment}</span>`;
      if (str) return `<span class="text-emerald-700">${str}</span>`;
      if (kw) return `<span class="text-[#6D28D9] font-medium">${kw}</span>`;
      if (num) return `<span class="text-[#4F46E5]">${num}</span>`;
      return _m;
    },
  );
}

export function CodeBlock({ code, className = '' }: { code: string; className?: string }) {
  return (
    <pre
      className={`font-mono text-[11.5px] leading-[1.6] text-gray-800 overflow-auto whitespace-pre ${className}`}
      dangerouslySetInnerHTML={{ __html: highlight(code) }}
    />
  );
}

/* ── Copy button ────────────────────────────────────────────────────────── */

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
          () => { /* clipboard blocked — the code is on screen and selectable */ },
        );
      }}
      className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border transition-all ${CHIP_3D} active:translate-y-px active:shadow-none ${
        copied
          ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
          : 'text-[#6B7280] bg-white border-gray-200 hover:text-[#7C3AED] hover:border-[#DDD6FE]'
      } ${className}`}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/* ── Pass-rate ring ─────────────────────────────────────────────────────── */

/**
 * The one hero visual for a run: an SVG donut that reads the outcome before any
 * number does. Colour follows the same outcome rule as everything else — a
 * healthy run is green, a shaky one amber, a failing one red — so the ring says
 * "good / watch / bad" at a glance and the centred figure gives the exact value.
 * Purely presentational: it renders a number the caller already has.
 */
export function PassRing({ value, size = 104, label }: { value: number; size?: number; label?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const stroke = Math.round(size * 0.1);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = (v / 100) * c;
  const tone = v >= 90 ? '#059669' : v >= 70 ? '#D97706' : '#DC2626';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Pass rate ${v}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EDE9FE" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${arc} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 600ms cubic-bezier(0.22,1,0.36,1)' }}
      />
      <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle" className="font-bold tabular-nums" style={{ fontSize: size * 0.26, fill: tone }}>{v}%</text>
      {label && <text x="50%" y="68%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: size * 0.1, fill: '#9CA3AF' }}>{label}</text>}
    </svg>
  );
}

/* ── Filter chip ────────────────────────────────────────────────────────── */

/**
 * The one chip the tabs reach for to filter a table — the violet pill from the
 * Scenarios tab, lifted out so Runs, History and Reports all filter the same
 * way. Active is the solid brand fill; inactive is the standard muted chip.
 */
export function FilterChip({
  active, onClick, children, count, tone = 'brand',
}: {
  active: boolean; onClick: () => void; children: ReactNode; count?: number;
  /** `brand` is the default violet; `danger` tints the active state red for a "Failed" filter. */
  tone?: 'brand' | 'danger';
}) {
  const activeCls = tone === 'danger' ? 'bg-red-500 text-white border-transparent' : 'bg-[#7C3AED] text-white border-transparent';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border text-[11px] font-medium transition-colors ${
        active ? activeCls : 'text-[#6B7280] bg-white border-gray-200 hover:text-[#7C3AED] hover:border-[#DDD6FE]'
      }`}
    >
      {children}
      {count !== undefined && <span className={active ? 'text-white/70 tabular-nums' : 'text-gray-400 tabular-nums'}>{count}</span>}
    </button>
  );
}

/* ── Duration bar ───────────────────────────────────────────────────────── */

/**
 * A hairline bar behind a row's duration, scaled to the slowest row — the
 * cheapest way to show which cases are the slow ones without a chart. The number
 * stays the source of truth; the bar is just a sense of proportion.
 */
export function DurationBar({ ms, max, className = '' }: { ms: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max(3, Math.round((ms / max) * 100)) : 0;
  return (
    <span className={`inline-block h-1 rounded-full bg-[#EDE9FE] overflow-hidden align-middle ${className}`} style={{ width: 40 }}>
      <span className="block h-full rounded-full bg-[#A78BFA]" style={{ width: `${pct}%` }} />
    </span>
  );
}

/* ── Tab hero banner ────────────────────────────────────────────────────── */

/**
 * The gradient header band that opens every workspace tab — the same violet→
 * indigo language as the Overview hero, in a compact form that sits above a
 * tab's own toolbar and table. Purely presentational: an icon, a title, an
 * optional subtitle and an optional right-aligned actions slot.
 */
export function TabHero({
  icon: Icon, title, subtitle, actions, className = '',
}: {
  icon: React.ElementType; title: string; subtitle?: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#5B21B6] via-[#7C3AED] to-[#4338CA] px-5 py-3.5 shadow-[0_18px_44px_-22px_rgba(76,29,149,0.75)] ${className}`}>
      <div className="pointer-events-none absolute -top-16 -right-8 w-56 h-56 rounded-full bg-[#E879F9]/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 w-56 h-56 rounded-full bg-[#22D3EE]/20 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '20px 20px' }} />
      <div className="relative flex items-center gap-3.5 flex-wrap">
        <span className="w-10 h-10 rounded-xl bg-white/15 border border-white/25 flex items-center justify-center flex-shrink-0 backdrop-blur-sm"><Icon className="w-5 h-5 text-white" /></span>
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold text-white leading-tight tracking-tight truncate">{title}</h2>
          {subtitle != null && subtitle !== '' && <p className="text-[11.5px] text-white/70 mt-0.5 min-w-0 truncate">{subtitle}</p>}
        </div>
        {actions && <div className="ml-auto flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

/* ── Empty state ────────────────────────────────────────────────────────── */

export function EmptyState({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-16">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-white to-[#F5F3FF] border border-[#E9E5FB] flex items-center justify-center mb-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_18px_-10px_rgba(76,29,149,0.4)]">
        <Icon className="w-5 h-5 text-[#A78BFA]" />
      </div>
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {hint && <p className="text-xs text-gray-400 mt-1 max-w-sm leading-relaxed">{hint}</p>}
    </div>
  );
}

