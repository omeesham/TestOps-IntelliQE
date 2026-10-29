import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Home, ClipboardList, Plug, FlaskConical, BarChart3, Bug, Users, Settings,
  Search, CornerDownLeft, Moon, Sun, LogOut, ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';

/** Fired by the header search button to open the palette from a click. */
export const OPEN_COMMAND_PALETTE = 'intelliqe:open-command-palette';

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  group: 'Navigate' | 'Actions';
  icon: React.ElementType;
  keywords?: string;
  run: () => void;
};

export default function CommandPalette() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => { setOpen(false); setQuery(''); setActive(0); }, []);

  const commands = useMemo<Cmd[]>(() => {
    const go = (path: string) => () => { navigate(path); close(); };
    return [
      { id: 'chat', label: 'Chat', hint: 'Tessa assistant', group: 'Navigate', icon: Home, keywords: 'tessa home generate', run: go('/chat') },
      { id: 'generated', label: 'Generated Test Cases', group: 'Navigate', icon: ClipboardList, keywords: 'tests cases runs', run: go('/generated-tests') },
      { id: 'automation', label: 'API Automation', hint: 'API Studio', group: 'Navigate', icon: Plug, keywords: 'api studio rest endpoints', run: go('/automation') },
      { id: 'weblab', label: 'Web Lab', group: 'Navigate', icon: FlaskConical, keywords: 'browser accessibility visual responsive', run: go('/web-lab') },
      { id: 'reports', label: 'Reports', group: 'Navigate', icon: BarChart3, keywords: 'allure results analytics', run: go('/reports') },
      { id: 'bugs', label: 'Bug Tracker', group: 'Navigate', icon: Bug, keywords: 'issues jira defects', run: go('/bug-tracker') },
      { id: 'users', label: 'User Management', group: 'Navigate', icon: Users, keywords: 'roles tenants accounts', run: go('/user-management') },
      { id: 'config', label: 'System Configuration', group: 'Navigate', icon: Settings, keywords: 'settings integrations llm storage', run: go('/system-configuration') },
      {
        id: 'theme', label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        group: 'Actions', icon: theme === 'dark' ? Sun : Moon, keywords: 'theme dark light appearance',
        run: () => { toggle(); close(); },
      },
      { id: 'logout', label: 'Sign out', group: 'Actions', icon: LogOut, keywords: 'logout exit', run: () => { logout(); navigate('/login'); close(); } },
    ];
  }, [navigate, close, theme, toggle, logout]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) || (c.keywords || '').includes(q) || (c.hint || '').toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Global hotkey (Cmd/Ctrl+K) + the header's open event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, onOpen);
    };
  }, []);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 20); }, [open]);
  useEffect(() => { setActive(0); }, [query]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); results[active]?.run(); }
  };

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[14vh] bg-[#0B0A14]/50 backdrop-blur-sm"
      onMouseDown={close}
    >
      <div
        data-surface="3d"
        className="w-full max-w-xl bg-white rounded-2xl border border-[#E7E3F5] overflow-hidden"
        // Plain white box: drop shadow-2xl AND override the global modal glow
        // (index.css §12.7 paints every .fixed.inset-0 > .bg-white with a violet
        // drop shadow; a bare class removal would let that glow show instead).
        style={{ boxShadow: 'none' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {/* Search field */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-[#ECE9F8]">
          <Search className="w-4.5 h-4.5 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and actions…"
            className="flex-1 bg-transparent border-0 outline-none shadow-none text-[15px] text-[#1E1B4B] placeholder-gray-400"
            style={{ boxShadow: 'none' }}
          />
          <kbd className="text-[10px] font-semibold text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {results.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-gray-400">No matches for “{query}”.</div>
          )}
          {results.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            const isActive = i === active;
            return (
              <div key={c.id}>
                {showGroup && (
                  <div className="px-4 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400">{c.group}</div>
                )}
                <button
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => c.run()}
                  className={`w-full flex items-center gap-3 px-3 mx-1 py-2.5 rounded-xl text-left transition-colors ${
                    isActive ? 'bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white' : 'text-[#1E1B4B] hover:bg-[#F5F3FF]'
                  }`}
                  style={{ width: 'calc(100% - 0.5rem)' }}
                >
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    isActive ? 'bg-white/20' : 'bg-[#F5F3FF] text-[#7C3AED]'
                  }`}>
                    <c.icon className="w-4 h-4" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="text-sm font-medium block truncate">{c.label}</span>
                    {c.hint && (
                      <span className={`text-xs ${isActive ? 'text-white/70' : 'text-gray-400'}`}>{c.hint}</span>
                    )}
                  </span>
                  {isActive
                    ? (c.group === 'Navigate' ? <ArrowRight className="w-4 h-4 opacity-80" /> : <CornerDownLeft className="w-4 h-4 opacity-80" />)
                    : null}
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2.5 border-t border-[#ECE9F8] text-[11px] text-gray-400">
          <span className="flex items-center gap-1"><CornerDownLeft className="w-3 h-3" /> to select</span>
          <span className="flex items-center gap-1"><span className="font-semibold">↑↓</span> to navigate</span>
          <span className="ml-auto flex items-center gap-1 font-semibold text-[#7C3AED]">
            <Search className="w-3 h-3" /> IntelliQE Command
          </span>
        </div>
      </div>
    </div>
  );
}
