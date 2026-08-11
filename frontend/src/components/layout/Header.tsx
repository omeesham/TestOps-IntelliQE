import { User, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';

const PAGE_TITLES: Record<string, string> = {
  '/chat': 'Chat',
  '/system-configuration': 'System Configuration',
  '/reports': 'Reports',
  '/login': 'Sign In',
  '/user-management': 'User Management',
  '/generated-tests': 'Generated Test Cases',
};

export default function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const pageTitle = PAGE_TITLES[location.pathname]
    || location.pathname.slice(1).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    || 'IntelliQE';

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className="h-14 bg-white/80 backdrop-blur-xl border-b border-[#DDD6FE]/60 flex items-center justify-between px-6 z-30 flex-shrink-0">
      <h1 className="text-lg font-bold text-[#1E1B4B]">{pageTitle}</h1>
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-gradient-to-br from-[#7C3AED] to-[#6366F1] rounded-full flex items-center justify-center shadow-md shadow-purple-500/20">
          <User className="w-4 h-4 text-white" />
        </div>
        <div className="text-sm hidden sm:block">
          <p className="font-medium text-[#1E1B4B] capitalize">{user?.username || 'User'}</p>
          <p className="text-[10px] text-gray-500">{user?.role || 'Guest'}</p>
        </div>
        <div className="w-px h-6 bg-gray-200 mx-1.5 hidden sm:block" />
        <button
          onClick={handleLogout}
          className="group ml-1 inline-flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 text-sm font-medium text-[#EF4444] bg-red-50/70 border border-red-200/80 rounded-lg shadow-sm hover:bg-[#EF4444] hover:text-white hover:border-[#EF4444] hover:shadow-md hover:shadow-red-500/20 active:scale-[0.97] transition-all duration-200"
          title="Sign out"
        >
          <LogOut className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
