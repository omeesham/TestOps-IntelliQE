/**
 * Requirements Management dashboard — shared presentational primitives.
 *
 * Every piece here is dumb UI (no data fetching): the donut, the processing
 * panel, the drag-and-drop well, the search/filter toolbar, the pager and the
 * badges. The tabs compose these against live data. All styling stays in the
 * app's violet/indigo language via the shared format.ts tokens.
 */
import { useRef, useState, type ReactNode, type ElementType } from 'react';
import { CheckCircle2, Circle, Loader2, UploadCloud, Search, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';
import { CARD, FIELD, THEAD, methodColor } from '../format';
import type { ProcessingStep, DonutSeg } from './util';

/* ── Section card — a titled white card with an icon, the dashboard's unit ── */
export function SectionCard({ icon: Icon, title, hint, right, children, className = '' }: { icon?: ElementType; title: string; hint?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`${CARD} flex flex-col min-h-0 ${className}`}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#F0EDFA] flex-shrink-0">
        {Icon && <Icon className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />}
        <h3 className="text-[13px] font-semibold text-gray-900">{title}</h3>
        {hint && <span className="text-[11px] text-gray-400 truncate">{hint}</span>}
        {right && <div className="ml-auto flex items-center gap-1.5">{right}</div>}
      </div>
      <div className="p-4 flex-1 min-h-0">{children}</div>
    </div>
  );
}

/* ── Coverage donut — pure SVG, no dependency. Center shows the headline %. ── */
export function CoverageDonut({ segments, centerValue, centerLabel, size = 132 }: { segments: DonutSeg[]; centerValue: string; centerLabel?: string; size?: number }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = (size - 16) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-shrink-0 -rotate-90">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#F1EEFB" strokeWidth={12} />
        {total > 0 && segments.map((s, i) => {
          const len = (s.value / total) * circ;
          const el = (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={12}
              strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset} strokeLinecap="butt" />
          );
          offset += len;
          return el;
        })}
        <text x={cx} y={cy} transform={`rotate(90 ${cx} ${cy})`} textAnchor="middle" dominantBaseline="central">
          <tspan x={cx} dy="-2" style={{ fontSize: 22, fontWeight: 700, fill: '#111827' }}>{centerValue}</tspan>
          {centerLabel && <tspan x={cx} dy="16" style={{ fontSize: 10, fill: '#9CA3AF' }}>{centerLabel}</tspan>}
        </text>
      </svg>
      <ul className="space-y-1.5 min-w-0">
        {segments.length === 0 && <li className="text-[11.5px] text-gray-400">No coverage data yet.</li>}
        {segments.map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-[12px]">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-gray-600">{s.label}</span>
            <span className="ml-auto font-semibold text-gray-800 tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Processing status — six real steps, each green when the data proves it ── */
export function ProcessingStatusPanel({ steps, loading }: { steps: ProcessingStep[]; loading?: boolean }) {
  // "Successfully processed" only once the data genuinely reaches generation —
  // document fetched, requirements extracted, APIs mapped, test cases generated.
  const core = ['fetch', 'extract', 'map', 'generate'];
  const processed = !loading && steps.filter((s) => core.includes(s.key)).every((s) => s.done);
  return (
    <>
    <ul className="space-y-2">
      {steps.map((s) => (
        <li key={s.key} className="flex items-center gap-2.5">
          {loading ? <Loader2 className="w-4 h-4 text-gray-300 animate-spin flex-shrink-0" />
            : s.done ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            : <Circle className="w-4 h-4 text-gray-300 flex-shrink-0" />}
          <span className={`text-[12.5px] ${s.done ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>{s.label}</span>
          {s.count != null && s.count > 0 && (
            <span className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md bg-[#F5F3FF] border border-[#DDD6FE] text-[11px] font-bold text-[#6D28D9] tabular-nums">{s.count}</span>
          )}
          {s.detail && <span className={`${s.count != null && s.count > 0 ? 'ml-1.5' : 'ml-auto'} text-[10.5px] text-gray-400`}>{s.detail}</span>}
        </li>
      ))}
    </ul>
    {processed && (
      <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200">
        <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-px" />
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-emerald-800 leading-tight">Successfully processed!</p>
          <p className="text-[11px] text-emerald-700 leading-tight">View results in the respective tabs.</p>
        </div>
      </div>
    )}
    </>
  );
}

/* ── Drag-and-drop well — the document intake the BRD/FRD modules were missing ── */
export function DropZone({ accept, formatsLabel, busy, onFile }: { accept: string; formatsLabel: string; busy?: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = (f?: File | null) => { if (f) onFile(f); };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) pick(e.dataTransfer.files?.[0]); }}
      onClick={() => !busy && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); inputRef.current?.click(); } }}
      className={`rounded-xl border-2 border-dashed px-5 py-8 text-center cursor-pointer transition-colors ${busy ? 'opacity-60 cursor-wait' : ''} ${over ? 'border-[#7C3AED] bg-[#F5F3FF]' : 'border-[#DDD6FE] bg-[#FCFBFF] hover:border-[#A78BFA] hover:bg-[#F8F6FF]'}`}
    >
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {busy ? <Loader2 className="w-7 h-7 text-[#7C3AED] mx-auto animate-spin" /> : <UploadCloud className="w-7 h-7 text-[#7C3AED] mx-auto" />}
      <p className="mt-2 text-[13px] font-medium text-gray-700">{busy ? 'Analysing document…' : 'Drag & drop a document here, or click to choose'}</p>
      <p className="mt-0.5 text-[11px] text-gray-400">Supported: {formatsLabel}</p>
    </div>
  );
}

/* ── Toolbar: a search box and an optional filter select ── */
export function TableToolbar({ search, onSearch, placeholder = 'Search…', children }: { search: string; onSearch: (v: string) => void; placeholder?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-2.5">
      <div className="relative flex-1 min-w-[180px]">
        <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} className={`${FIELD} w-full pl-8`} />
      </div>
      {children}
    </div>
  );
}

/* ── Pager: 1-based, with the "n–m of total" summary ── */
export function Pager({ page, pageCount, from, to, total, onPage }: { page: number; pageCount: number; from: number; to: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between mt-2.5 text-[11.5px] text-gray-500">
      <span>Showing {from}–{to} of {total}</span>
      <div className="flex items-center gap-1">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-gray-200 text-gray-500 disabled:opacity-40 hover:bg-gray-50 hover:text-[#7C3AED]"><ChevronLeft className="w-4 h-4" /></button>
        <span className="px-2 tabular-nums">{page} / {pageCount}</span>
        <button type="button" disabled={page >= pageCount} onClick={() => onPage(page + 1)} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-gray-200 text-gray-500 disabled:opacity-40 hover:bg-gray-50 hover:text-[#7C3AED]"><ChevronRight className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

/* ── Badges ── */
export function MethodBadge({ method }: { method: string }) {
  return <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${methodColor(method)}`}>{method || '—'}</span>;
}

const SOURCE_STYLE: Record<string, string> = {
  brd: 'bg-[#F5F3FF] text-[#6D28D9] border-[#DDD6FE]',
  frd: 'bg-[#E0E7FF] text-[#4338CA] border-[#C7D2FE]',
  manual: 'bg-gray-100 text-gray-600 border-gray-200',
};
export function SourceBadge({ source }: { source: string }) {
  return <span className={`inline-flex px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase ${SOURCE_STYLE[source] || SOURCE_STYLE.manual}`}>{source}</span>;
}

const TRACE_STYLE: Record<string, string> = {
  covered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
  failing: 'bg-red-50 text-red-700 border-red-200',
  uncovered: 'bg-gray-100 text-gray-500 border-gray-200',
};
export function StatusPill({ status }: { status: string }) {
  return <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10.5px] font-semibold capitalize ${TRACE_STYLE[status] || TRACE_STYLE.uncovered}`}>{status}</span>;
}

/** Mapping status — "Mapped" (has endpoints) vs "Unmapped", in the reference's language. */
export function MappingBadge({ mapped }: { mapped: boolean }) {
  return mapped
    ? <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10.5px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200"><CheckCircle2 className="w-3 h-3" />Mapped</span>
    : <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10.5px] font-semibold bg-amber-50 text-amber-700 border-amber-200"><AlertTriangle className="w-3 h-3" />Unmapped</span>;
}

/* ── Review-flag chip (incomplete / ambiguous / conflict / ok) ── */
const FLAG_STYLE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  incomplete: 'bg-amber-50 text-amber-700 border-amber-200',
  ambiguous: 'bg-orange-50 text-orange-700 border-orange-200',
  conflict: 'bg-red-50 text-red-700 border-red-200',
};
export function FlagPill({ code }: { code: string }) {
  const label = code === 'ok' ? 'Clear' : code;
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold capitalize ${FLAG_STYLE[code] || FLAG_STYLE.incomplete}`}>{code !== 'ok' && <AlertTriangle className="w-2.5 h-2.5" />}{label}</span>;
}

/** Automation status — "Generated" once a requirement has cases, else "—". */
export function AutomationChip({ generated }: { generated: boolean }) {
  return generated
    ? <span className="inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-[#F5F3FF] text-[#6D28D9] border-[#DDD6FE]">Generated</span>
    : <span className="text-gray-300">—</span>;
}

/** Execution status in the mockup's language (Passed / Failed / Partial / Not run). */
export function ExecutionPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    covered: { label: 'Passed', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    failing: { label: 'Failed', cls: 'bg-red-50 text-red-700 border-red-200' },
    partial: { label: 'Partial', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    uncovered: { label: 'Not run', cls: 'bg-gray-100 text-gray-500 border-gray-200' },
  };
  const m = map[status] || map.uncovered;
  return <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10.5px] font-semibold ${m.cls}`}>{m.label}</span>;
}

/* ── Table shells so every tab's table reads identically ── */
export function TableHead({ cols }: { cols: { label: string; className?: string }[] }) {
  return (
    <thead className={THEAD}>
      <tr className="text-left text-gray-500">
        {cols.map((c, i) => <th key={i} className={`font-semibold px-3 py-2 ${c.className || ''}`}>{c.label}</th>)}
      </tr>
    </thead>
  );
}

export function EmptyRow({ span, text }: { span: number; text: string }) {
  return <tr><td colSpan={span} className="px-3 py-8 text-center text-gray-400 text-[12px]">{text}</td></tr>;
}
