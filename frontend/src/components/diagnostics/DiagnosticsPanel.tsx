/**
 * In-app Diagnostics panel — the "I can see the logs" surface.
 *
 * A floating launcher (also toggled with Ctrl/Cmd+Shift+D) opens a slide-over
 * that streams the logger's ring buffer live: every click breadcrumb, route
 * change, API call, and error — with level, category, latency, and the backend
 * correlation id. Filter by level, search the text, expand an entry to see its
 * structured data, and copy/download a full diagnostic bundle to attach to a
 * bug report.
 *
 * Everything shown here is already redacted by the logger, so it is safe to
 * leave available in production for support/QA.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, X, Search, Download, Copy, Trash2, ChevronDown, ChevronRight,
  AlertCircle, AlertTriangle, Info, Bug, Check,
} from 'lucide-react';
import { log, subscribe, getEntries, clearEntries, type LogEntry, type LogLevel } from '@/utils/logger';

const LEVEL_META: Record<LogLevel, { label: string; dot: string; text: string; Icon: React.ElementType }> = {
  debug: { label: 'Debug', dot: 'bg-gray-400',    text: 'text-gray-500',   Icon: Bug },
  info:  { label: 'Info',  dot: 'bg-violet-500',  text: 'text-violet-700', Icon: Info },
  warn:  { label: 'Warn',  dot: 'bg-amber-500',   text: 'text-amber-700',  Icon: AlertTriangle },
  error: { label: 'Error', dot: 'bg-red-500',     text: 'text-red-700',    Icon: AlertCircle },
};

const ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export default function DiagnosticsPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>(() => getEntries());
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set<LogLevel>(['info', 'warn', 'error']));
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
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

  // Auto-scroll to the newest entry while open.
  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (!levels.has(e.level)) return false;
      if (!q) return true;
      return (
        e.message.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.requestId || '').toLowerCase().includes(q) ||
        JSON.stringify(e.data || '').toLowerCase().includes(q)
      );
    });
  }, [entries, levels, query]);

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

  const onClear = () => { clearEntries(); setEntries([]); setExpanded(null); };

  return (
    <>
      {/* Floating launcher */}
      <button
        onClick={() => setOpen(true)}
        title="Open diagnostics (Ctrl+Shift+D)"
        aria-label="Open diagnostics"
        className="fixed bottom-4 left-4 z-40 w-10 h-10 rounded-full bg-[#1E1B4B] text-white shadow-lg hover:bg-[#312E81] flex items-center justify-center"
      >
        <Activity className="w-5 h-5" />
        {errorCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {errorCount > 99 ? '99+' : errorCount}
          </span>
        )}
      </button>

      {!open ? null : (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Diagnostics">
          <div className="absolute inset-0 bg-black/20" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-2xl h-full bg-white shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
              <Activity className="w-4 h-4 text-[#7C3AED]" />
              <h2 className="text-sm font-semibold text-[#1E1B4B]">Diagnostics</h2>
              <span className="text-[11px] font-mono text-gray-400">session {log.getSessionId().slice(0, 8)}</span>
              <div className="ml-auto flex items-center gap-1">
                <IconBtn title={copied ? 'Copied!' : 'Copy diagnostic bundle'} onClick={copyBundle}>
                  {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                </IconBtn>
                <IconBtn title="Download diagnostic bundle" onClick={() => log.download()}>
                  <Download className="w-4 h-4" />
                </IconBtn>
                <IconBtn title="Clear logs" onClick={onClear}>
                  <Trash2 className="w-4 h-4" />
                </IconBtn>
                <IconBtn title="Close" onClick={() => setOpen(false)}>
                  <X className="w-4 h-4" />
                </IconBtn>
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 flex-wrap">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search message, category, request id…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-[#7C3AED]"
                />
              </div>
              {ORDER.map((lvl) => {
                const m = LEVEL_META[lvl];
                const active = levels.has(lvl);
                return (
                  <button
                    key={lvl}
                    onClick={() => toggleLevel(lvl)}
                    className={`px-2 py-1 text-[11px] rounded-md border inline-flex items-center gap-1 ${
                      active ? 'border-gray-300 bg-gray-50 text-gray-700' : 'border-gray-200 text-gray-300'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${m.dot} ${active ? '' : 'opacity-30'}`} />
                    {m.label}
                  </button>
                );
              })}
            </div>

            {/* Log stream */}
            <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[11px]">
              {visible.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-xs">
                  No log entries match the current filter.
                </div>
              ) : (
                visible.map((e) => (
                  <LogRow key={e.id} entry={e} open={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400 flex items-center justify-between">
              <span>{visible.length} shown · {entries.length} captured (max 500)</span>
              <span>Ctrl+Shift+D toggles this panel</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700">
      {children}
    </button>
  );
}

function LogRow({ entry, open, onToggle }: { entry: LogEntry; open: boolean; onToggle: () => void }) {
  const m = LEVEL_META[entry.level];
  const hasData = entry.data && Object.keys(entry.data).length > 0;
  const time = entry.ts.slice(11, 23); // HH:MM:SS.mmm

  return (
    <div className={`border-b border-gray-50 ${entry.level === 'error' ? 'bg-red-50/40' : entry.level === 'warn' ? 'bg-amber-50/30' : ''}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-50"
      >
        {hasData ? (
          open ? <ChevronDown className="w-3 h-3 mt-0.5 text-gray-400 flex-shrink-0" />
               : <ChevronRight className="w-3 h-3 mt-0.5 text-gray-400 flex-shrink-0" />
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <span className="text-gray-400 flex-shrink-0">{time}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${m.dot} mt-1.5 flex-shrink-0`} />
        <span className="text-gray-400 flex-shrink-0 w-12 truncate" title={entry.category}>{entry.category}</span>
        <span className={`flex-1 break-words ${m.text}`}>{entry.message}</span>
        {typeof entry.durationMs === 'number' && (
          <span className="text-gray-400 flex-shrink-0">{entry.durationMs}ms</span>
        )}
        {entry.requestId && (
          <span className="text-gray-300 flex-shrink-0 select-all" title={entry.requestId}>{entry.requestId.slice(0, 8)}</span>
        )}
      </button>
      {open && hasData && (
        <pre className="mx-3 mb-2 p-2 bg-gray-50 border border-gray-100 rounded text-[10px] text-gray-600 overflow-auto max-h-60 whitespace-pre-wrap">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
