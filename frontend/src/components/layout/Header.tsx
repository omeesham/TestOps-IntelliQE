import { User, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';

const PAGE_TITLES: Record<string, string> = {
  '/chat': 'Chat',
  '/dashboard': 'Overview',
  '/system-configuration': 'System Configuration',
  '/reports': 'Reports',
  '/agents': 'Agent Monitor',
  '/login': 'Sign In',
  '/user-management': 'User Management',
  '/generated-tests': 'Generated Test Cases',
  '/automation-scripts': 'Automation Scripts',
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
    <header className="h-14 bg-white/80 backdrop-blur-xl border-b border-[#C9DCFF]/60 flex items-center justify-between px-6 z-30 flex-shrink-0">
      <h1 className="text-lg font-bold text-[#1E1B4B]">{pageTitle}</h1>
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-[#155dfc] rounded-full flex items-center justify-center shadow-md shadow-blue-500/20">
          <User className="w-4 h-4 text-white" />
        </div>
        <div className="text-sm hidden sm:block">
          <p className="font-medium text-[#1E1B4B] capitalize">{user?.username || 'User'}</p>
          <p className="text-[10px] text-gray-500">{user?.role || 'Guest'}</p>
        </div>
        <button
          onClick={handleLogout}
          className="ml-1 p-1.5 text-gray-400 hover:text-[#EF4444] transition-colors rounded-lg hover:bg-red-50"
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
