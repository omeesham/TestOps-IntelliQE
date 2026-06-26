import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth, type UserRole } from '@/contexts/AuthContext';
import { useFeatureFlags } from '@/contexts/FeatureFlagsContext';
import { PATH_FEATURE_KEY } from '@/featureCatalog';
import { getMenuConfig } from '@/services/api';
import {
  Home, LayoutDashboard, ClipboardList, Code2, BarChart3, Video, Cpu, Users, Settings,
  SlidersHorizontal, ChevronLeft, ChevronRight,
} from 'lucide-react';

interface NavItem {
  name: string;
  path: string;
  icon: React.ElementType;
  roles: UserRole[];
}

const ALL: UserRole[] = ['admin', 'qa_engineer', 'data_analyst'];

// Build stamp injected at build time (Dockerfile ARG -> VITE_APP_VERSION).
// Format: V<build>-DDMMYY (e.g. "V42-150626"). Falls back to "dev" locally.
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) || 'dev';

const navItems: NavItem[] = [
  { name: 'Chat',                  path: '/chat',                 icon: Home,            roles: ALL },
  { name: 'Dashboard',             path: '/dashboard',            icon: LayoutDashboard, roles: ALL },
  { name: 'Generated Test Cases',  path: '/generated-tests',      icon: ClipboardList,   roles: ALL },
  { name: 'Automation Scripts',    path: '/automation-scripts',   icon: Code2,           roles: ALL },
  { name: 'Reports',               path: '/reports',              icon: BarChart3,       roles: ALL },
  { name: 'Execution Recordings',  path: '/execution-recordings', icon: Video,           roles: ALL },
  { name: 'Agent Monitor',         path: '/agents',               icon: Cpu,             roles: ['admin'] },
  { name: 'User Management',       path: '/user-management',      icon: Users,           roles: ['admin', 'qa_engineer'] },
  { name: 'System Configuration',  path: '/system-configuration', icon: Settings,        roles: ['admin', 'qa_engineer'] },
  // Always reachable — this is where features get re-enabled, so it's never gated.
  { name: 'Feature Toggles',       path: '/feature-toggles',      icon: SlidersHorizontal, roles: ALL },
];

export default function Sidebar() {
  const { user } = useAuth();
  const { isEnabled } = useFeatureFlags();
  const role: UserRole = (user?.role as UserRole) || 'admin';
  const [allowedPaths, setAllowedPaths] = useState<string[] | null>(null);
  const [, setMenuLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('sidebar_collapsed') === '1';
  });

  useEffect(() => {
    getMenuConfig()
      .then((data) => setAllowedPaths(data.allowedPaths))
      .catch(() => setAllowedPaths(null))
      .finally(() => setMenuLoaded(true));
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebar_collapsed', next ? '1' : '0');
      return next;
    });
  };

  const visibleItems = navItems.filter((item) => {
    if (!item.roles.includes(role)) return false;
    if (allowedPaths && !allowedPaths.includes(item.path)) return false;
    // Feature-flag gate (additive): hide items whose feature is toggled off.
    const featureKey = PATH_FEATURE_KEY[item.path];
    if (featureKey && !isEnabled(featureKey)) return false;
    return true;
  });

  return (
    <aside
      className={`${collapsed ? 'w-16' : 'w-64'} bg-[#1E3A8A] h-full overflow-hidden flex flex-col transition-all duration-200 flex-shrink-0`}
    >
      <div
        className={`${collapsed ? 'px-2 py-3 flex-col gap-2' : 'px-4 py-3 justify-between gap-2'} border-b border-white/10 flex items-center`}
      >
        <img
          src="/jbs-logo-main.png"
          alt="JBS"
          className={collapsed ? 'h-9 w-9 object-contain' : 'h-9 w-auto'}
        />
        <button
          onClick={toggleCollapsed}
          className="w-7 h-7 rounded-md bg-white/5 text-[#AEC4F5] hover:bg-white/10 hover:text-white flex items-center justify-center transition-colors flex-shrink-0"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      <nav className={`flex-1 ${collapsed ? 'p-2' : 'p-3'} space-y-0.5 overflow-y-auto scrollbar-hide`}>
        {visibleItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            title={collapsed ? item.name : undefined}
            className={({ isActive }) =>
              `flex items-center gap-3 ${collapsed ? 'justify-center px-2' : 'px-3'} py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-[#3366FF] text-white shadow-md shadow-[#3366FF]/25'
                  : 'text-[#AEC4F5] hover:bg-white/5 hover:text-white'
              }`
            }
          >
            <item.icon className="w-4 h-4 flex-shrink-0" />
            {!collapsed && <span className="truncate">{item.name}</span>}
          </NavLink>
        ))}
      </nav>

      <div
        className={`border-t border-white/10 ${collapsed ? 'px-2 py-2' : 'px-4 py-2'} text-[10px] font-medium uppercase tracking-wider text-[#AEC4F5]/50 text-center select-none`}
        title={`Build ${APP_VERSION}`}
      >
        {collapsed ? APP_VERSION.split('-')[0] : APP_VERSION}
      </div>
    </aside>
  );
}
