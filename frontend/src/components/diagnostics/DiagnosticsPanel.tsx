/**
 * In-app Diagnostics panel — the "I can see the logs" surface, rendered as a
 * live 3D stream.
 *
 * A floating launcher (also toggled with Ctrl/Cmd+Shift+D) opens a slide-over
 * that streams the logger's ring buffer live: every click, field change, form
 * submit, route change, API call, and error — with level, category, latency,
 * and the backend correlation id. Each entry is a depth-styled card that flies
 * in as it is captured. Filter by level, filter by category, search the text,
 * expand an entry to see its structured data, and copy/download a full
 * diagnostic bundle to attach to a bug report.
 *
 * Everything shown here is already redacted by the logger, so it is safe to
 * leave available in production for support/QA.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, X, Search, Download, Copy, Trash2, ChevronDown, ChevronRight,
  AlertCircle, AlertTriangle, Info, Bug, Check, MousePointerClick, Keyboard,
  Navigation, Send, Globe, Server, Eye, Layers, Zap, CircleDot,
} from 'lucide-react';
import { log, subscribe, getEntries, clearEntries, type LogEntry, type LogLevel } from '@/utils/logger';

const LEVEL_META: Record<LogLevel, { label: string; dot: string; text: string; spine: string; chip: string; Icon: React.ElementType }> = {
  debug: { label: 'Debug', dot: 'bg-slate-400',  text: 'text-slate-500',  spine: 'from-slate-300 to-slate-400',   chip: 'bg-slate-100 text-slate-600',   Icon: Bug },
  info:  { label: 'Info',  dot: 'bg-violet-500',  text: 'text-violet-700', spine: 'from-violet-400 to-indigo-500', chip: 'bg-violet-100 text-violet-700', Icon: Info },
  warn:  { label: 'Warn',  dot: 'bg-amber-500',   text: 'text-amber-700',  spine: 'from-amber-400 to-orange-500',  chip: 'bg-amber-100 text-amber-700',   Icon: AlertTriangle },
  error: { label: 'Error', dot: 'bg-red-500',     text: 'text-red-700',    spine: 'from-red-400 to-rose-600',      chip: 'bg-red-100 text-red-700',       Icon: AlertCircle },
};

const ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Category → icon + accent, so a glance tells you the KIND of move captured.
const CATEGORY_META: Record<string, { Icon: React.ElementType; color: string }> = {
  ui:     { Icon: MousePointerClick, color: 'text-violet-500' },
  input:  { Icon: Keyboard,          color: 'text-sky-500' },
  nav:    { Icon: Navigation,        color: 'text-emerald-500' },
  api:    { Icon: Server,            color: 'text-indigo-500' },
  route:  { Icon: Navigation,        color: 'text-emerald-500' },
  render: { Icon: Layers,            color: 'text-fuchsia-500' },
  global: { Icon: Globe,             color: 'text-rose-500' },
  app:    { Icon: Zap,               color: 'text-amber-500' },
};

// A per-event glyph inferred from data.event, for the richest detail.
const EVENT_ICON: Record<string, React.ElementType> = {
  click: MousePointerClick,
  change: Keyboard,
  focus: Eye,
  submit: Send,
  navigate: Navigation,
  visibility: Eye,
};

function categoryMeta(cat: string) {
  return CATEGORY_META[cat] || { Icon: CircleDot, color: 'text-gray-400' };
}

export default function DiagnosticsPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>(() => getEntries());
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set<LogLevel>(['debug', 'info', 'warn', 'error']));
  const [category, setCategory] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live subscription to the logger.
  useEffect(() => {
    const unsub = subscribe((entry) => {
      setEntries((prev) => {
        const next = prev.length >= 500 ? [...prev.slice(-499), entry] : [...prev, entry];
        return next;
      });
      if ((entry.level === 'error' || entry.level === 'warn')) setErrorCount((c) => c + 1);
    });
    return unsub;
  }, []);

  // Keyboard toggle: Ctrl/Cmd+Shift+D.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset the unread badge when opened.
  useEffect(() => { if (open) setErrorCount(0); }, [open]);

  // Auto-scroll to the newest entry while open (unless the user scrolled up).
  useEffect(() => {
    if (open && autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, open, autoScroll]);

  // Distinct categories present, for the category filter row.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.category);
    return Array.from(set).sort();
  }, [entries]);

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of entries) c[e.level]++;
    return c;
  }, [entries]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (!levels.has(e.level)) return false;
      if (category !== 'all' && e.category !== category) return false;
      if (!q) return true;
      return (
        e.message.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.requestId || '').toLowerCase().includes(q) ||
        JSON.stringify(e.data || '').toLowerCase().includes(q)
      );
    });
  }, [entries, levels, category, query]);

  const toggleLevel = (lvl: LogLevel) =>
    setLevels((prev) => {
      const next = new Set(prev);
      next.has(lvl) ? next.delete(lvl) : next.add(lvl);
      return next;
    });

  const copyBundle = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(log.exportBundle(), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — fall back to download */ log.download(); }
  };

  const onClear = () => { clearEntries(); setEntries([]); setExpanded(null); setErrorCount(0); };

  // Track whether the user has scrolled away from the bottom (pause auto-scroll).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAutoScroll(atBottom);
  };

  return (
    <>
      {/* Floating launcher */}
      <button
        onClick={() => setOpen(true)}
        title="Open diagnostics (Ctrl+Shift+D)"
        aria-label="Open diagnostics"
        className="fixed bottom-4 left-4 z-40 w-11 h-11 rounded-full bg-gradient-to-br from-[#312E81] to-[#1E1B4B] text-white shadow-[0_10px_24px_-8px_rgba(30,27,75,0.7),inset_0_1px_1px_rgba(255,255,255,0.25)] hover:from-[#3b3699] hover:to-[#25215c] hover:-translate-y-0.5 transition-transform flex items-center justify-center"
      >
        <Activity className="w-5 h-5" />
        {errorCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow">
            {errorCount > 99 ? '99+' : errorCount}
          </span>
        )}
      </button>

      {!open ? null : (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Diagnostics">
          <div className="absolute inset-0 bg-[#1E1B4B]/30 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-2xl h-full bg-gradient-to-b from-white to-slate-50 shadow-2xl flex flex-col ring-1 ring-black/5">
            {/* Header — deep gradient with a live indicator */}
            <div className="flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-[#1E1B4B] via-[#312E81] to-[#4338CA] text-white">
              <div className="w-8 h-8 rounded-xl bg-white/15 flex items-center justify-center shadow-inner">
                <Activity className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Diagnostics</h2>
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                    <span className="diag-live-dot w-1.5 h-1.5 rounded-full bg-emerald-400" /> Live
                  </span>
                </div>
                <span className="text-[10px] font-mono text-white/50">session {log.getSessionId().slice(0, 8)}</span>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <HeaderBtn title={copied ? 'Copied!' : 'Copy diagnostic bundle'} onClick={copyBundle}>
                  {copied ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
                </HeaderBtn>
                <HeaderBtn title="Download diagnostic bundle" onClick={() => log.download()}>
                  <Download className="w-4 h-4" />
                </HeaderBtn>
                <HeaderBtn title="Clear logs" onClick={onClear}>
                  <Trash2 className="w-4 h-4" />
                </HeaderBtn>
                <HeaderBtn title="Close" onClick={() => setOpen(false)}>
                  <X className="w-4 h-4" />
                </HeaderBtn>
              </div>
            </div>

            {/* Live stat strip — animated counts per level */}
            <div className="grid grid-cols-4 gap-2 px-4 py-2.5 bg-[#1E1B4B] text-white">
              {ORDER.map((lvl) => {
                const m = LEVEL_META[lvl];
                const active = levels.has(lvl);
                return (
                  <button
                    key={lvl}
                    onClick={() => toggleLevel(lvl)}
                    title={`Toggle ${m.label}`}
                    className={`rounded-lg px-2 py-1.5 text-left transition-all ${
                      active ? 'bg-white/10 ring-1 ring-white/15' : 'bg-white/[0.03] opacity-45'
                    } hover:bg-white/15`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
                      <span className="text-[10px] uppercase tracking-wide text-white/60">{m.label}</span>
                    </div>
                    <div className="text-base font-bold tabular-nums leading-tight">{counts[lvl]}</div>
                  </button>
                );
              })}
            </div>

            {/* Toolbar — search + category filter */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 flex-wrap bg-white">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search message, category, request id…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-[#7C3AED]"
                />
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                <CatChip label="All" active={category === 'all'} onClick={() => setCategory('all')} />
                {categories.map((c) => (
                  <CatChip key={c} label={c} active={category === c} icon={categoryMeta(c).Icon} onClick={() => setCategory(c)} />
                ))}
              </div>
            </div>

            {/* Log stream — 3D depth */}
            <div ref={scrollRef} onScroll={onScroll} className="diag-stream flex-1 overflow-auto px-3 py-3 space-y-1.5 bg-gradient-to-b from-slate-50 to-white">
              {visible.length === 0 ? (
                <div className="p-10 text-center text-gray-400 text-xs">
                  No log entries match the current filter.
                </div>
              ) : (
                visible.map((e) => (
                  <LogRow key={e.id} entry={e} open={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-500 flex items-center justify-between bg-white">
              <span>
                {visible.length} shown · {entries.length} captured (max 500)
                {!autoScroll && <span className="ml-2 text-amber-600">• scroll paused</span>}
              </span>
              <span className="text-gray-400">Ctrl+Shift+D toggles this panel</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function HeaderBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="p-1.5 rounded-md text-white/70 hover:bg-white/15 hover:text-white transition-colors">
      {children}
    </button>
  );
}

function CatChip({ label, active, icon: Icon, onClick }: { label: string; active: boolean; icon?: React.ElementType; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-[11px] rounded-md border inline-flex items-center gap-1 capitalize transition-colors ${
        active ? 'border-[#7C3AED] bg-violet-50 text-[#7C3AED] font-medium' : 'border-gray-200 text-gray-500 hover:border-gray-300'
      }`}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {label}
    </button>
  );
}

function LogRow({ entry, open, onToggle }: { entry: LogEntry; open: boolean; onToggle: () => void }) {
  const m = LEVEL_META[entry.level];
  const cat = categoryMeta(entry.category);
  const hasData = entry.data && Object.keys(entry.data).length > 0;
  const time = entry.ts.slice(11, 23); // HH:MM:SS.mmm
  const eventKind = typeof entry.data?.event === 'string' ? (entry.data.event as string) : undefined;
  const EventIcon = (eventKind && EVENT_ICON[eventKind]) || cat.Icon;

  return (
    <div className="diag-row relative rounded-lg bg-white border border-gray-100 shadow-[0_2px_8px_-4px_rgba(30,27,75,0.18)] overflow-hidden">
      {/* Colored level spine */}
      <span className={`absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b ${m.spine}`} />
      <button onClick={onToggle} className="w-full flex items-start gap-2 pl-3 pr-2.5 py-2 text-left hover:bg-slate-50/70">
        {/* Category / event icon tile */}
        <span className={`mt-0.5 w-6 h-6 rounded-md bg-slate-50 border border-slate-100 flex items-center justify-center flex-shrink-0 ${cat.color}`}>
          <EventIcon className="w-3.5 h-3.5" />
        </span>

        <span className="flex-1 min-w-0">
          {/* Top line: time · level chip · category */}
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[10px] text-gray-400 tabular-nums">{time}</span>
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide ${m.chip}`}>
              <m.Icon className="w-2.5 h-2.5" /> {m.label}
            </span>
            <span className="text-[10px] text-gray-400 font-medium">{entry.category}</span>
            {typeof entry.durationMs === 'number' && (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-mono text-gray-500">
                <LatencyBar ms={entry.durationMs} />
                {entry.durationMs}ms
              </span>
            )}
          </span>
          {/* Message */}
          <span className={`block mt-0.5 text-xs font-mono break-words ${m.text}`}>{entry.message}</span>
          {/* Request id */}
          {entry.requestId && (
            <span className="mt-0.5 inline-block font-mono text-[10px] text-gray-300 select-all" title={entry.requestId}>
              req {entry.requestId.slice(0, 8)}
            </span>
          )}
        </span>

        {hasData && (
          open ? <ChevronDown className="w-3.5 h-3.5 mt-1 text-gray-400 flex-shrink-0" />
               : <ChevronRight className="w-3.5 h-3.5 mt-1 text-gray-400 flex-shrink-0" />
        )}
      </button>
      {open && hasData && (
        <pre className="mx-3 mb-2.5 p-2.5 bg-[#1E1B4B] text-violet-100 border border-indigo-900/40 rounded-md text-[10px] overflow-auto max-h-72 whitespace-pre-wrap font-mono leading-relaxed">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** A tiny latency bar — green (fast) → amber → red (slow). */
function LatencyBar({ ms }: { ms: number }) {
  const pct = Math.min(100, (ms / 2000) * 100);
  const color = ms < 400 ? 'bg-emerald-400' : ms < 1200 ? 'bg-amber-400' : 'bg-red-400';
  return (
    <span className="inline-block w-8 h-1.5 rounded-full bg-gray-100 overflow-hidden align-middle">
      <span className={`block h-full ${color}`} style={{ width: `${Math.max(8, pct)}%` }} />
    </span>
  );
}
