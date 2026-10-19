import { useState, useRef, useEffect } from 'react';
import { User, LogOut, Search, Moon, Sun, ChevronDown, Command } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useNavigate, useLocation } from 'react-router-dom';
import { OPEN_COMMAND_PALETTE } from './CommandPalette';

const PAGE_TITLES: Record<string, string> = {
  '/chat': 'Chat',
  '/system-configuration': 'System Configuration',
  '/reports': 'Reports',
  '/login': 'Sign In',
  '/user-management': 'User Management',
  '/generated-tests': 'Generated Test Cases',
  '/automation': 'API Automation',
  '/web-lab': 'Web Lab',
  '/bug-tracker': 'Bug Tracker',
};

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  qa_engineer: 'QA Engineer',
  data_analyst: 'Data Analyst',
};

export default function Header() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const pageTitle = PAGE_TITLES[location.pathname]
    || location.pathname.slice(1).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    || 'IntelliQE';

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const initials = (user?.username || 'U').slice(0, 2).toUpperCase();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="h-14 bg-white/80 backdrop-blur-xl border-b border-[#DDD6FE]/60 flex items-center justify-between gap-4 px-6 z-30 flex-shrink-0">
      {/* Left — page title */}
      <div className="flex items-center gap-3 min-w-0">
        <h1 className="text-lg font-bold text-[#1E1B4B] truncate">{pageTitle}</h1>
      </div>

      {/* Center — command / search trigger */}
      <button
        onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
        className="group hidden md:flex items-center gap-2.5 flex-1 max-w-md px-3.5 py-2 rounded-xl bg-[#F5F3FF] border border-[#E7E3F5] text-gray-400 hover:border-[#DDD6FE] hover:text-gray-500 transition-colors"
        title="Search (Ctrl/Cmd + K)"
      >
        <Search className="w-4 h-4 flex-shrink-0" />
        <span className="text-[13px] flex-1 text-left">Search or jump to…</span>
        <span className="flex items-center gap-0.5 text-[11px] font-semibold text-gray-400 bg-white border border-[#E7E3F5] rounded-md px-1.5 py-0.5">
          {isMac ? <Command className="w-3 h-3" /> : <span>Ctrl</span>}K
        </span>
      </button>

      {/* Right — status, theme, user */}
      <div className="flex items-center gap-2">
        {/* Live status pill */}
        <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-[11px] font-semibold text-emerald-700">Operational</span>
        </div>

        {/* Mobile search */}
        <button
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
          className="md:hidden p-2 rounded-lg text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] transition-colors"
          title="Search"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* Theme toggle */}
        <button
          onClick={toggle}
          className="p-2 rounded-lg text-gray-500 hover:text-[#7C3AED] hover:bg-[#F5F3FF] transition-colors"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
        </button>

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-xl hover:bg-[#F5F3FF] transition-colors"
          >
            <div className="w-8 h-8 bg-gradient-to-br from-[#7C3AED] to-[#6366F1] rounded-full flex items-center justify-center shadow-md shadow-purple-500/20 text-white text-xs font-bold">
              {initials}
            </div>
            <div className="text-sm hidden sm:block text-left">
              <p className="font-medium text-[#1E1B4B] capitalize leading-tight">{user?.username || 'User'}</p>
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] w-60 bg-white rounded-2xl border border-[#E7E3F5] shadow-2xl py-1.5 z-50 animate-fadeIn">
              <div className="px-4 py-3 border-b border-[#ECE9F8]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gradient-to-br from-[#7C3AED] to-[#6366F1] rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                    {initials}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-[#1E1B4B] capitalize truncate">{user?.username || 'User'}</p>
                    <p className="text-xs text-gray-500 truncate">{ROLE_LABELS[user?.role || ''] || user?.role || ''}</p>
                  </div>
                </div>
                {user?.tenantName && (
                  <div className="mt-2 text-[11px] text-gray-400">
                    Workspace: <span className="font-medium text-gray-500">{user.tenantName}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => { toggle(); }}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-[#1E1B4B] hover:bg-[#F5F3FF] transition-colors"
              >
                {theme === 'dark' ? <Sun className="w-4 h-4 text-gray-400" /> : <Moon className="w-4 h-4 text-gray-400" />}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
              <button
                onClick={() => { navigate('/system-configuration'); setMenuOpen(false); }}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-[#1E1B4B] hover:bg-[#F5F3FF] transition-colors"
              >
                <User className="w-4 h-4 text-gray-400" />
                Settings
              </button>
              <div className="h-px bg-[#ECE9F8] my-1" />
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-[#EF4444] hover:bg-red-50 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
