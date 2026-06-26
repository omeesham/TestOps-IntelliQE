import { Outlet, useLocation, Navigate } from 'react-router-dom';
import { useRef } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import ChatPage from '@/pages/ChatPage';
import { useFeatureFlags } from '@/contexts/FeatureFlagsContext';
import { PATH_FEATURE_KEY } from '@/featureCatalog';

export default function Layout() {
  const location = useLocation();
  const { isEnabled, loaded } = useFeatureFlags();

  // Route-level enforcement (covers direct URL access): if the current page's
  // feature is toggled off, bounce to the always-available Feature Toggles screen.
  const pageFeatureKey = PATH_FEATURE_KEY[location.pathname];
  if (loaded && pageFeatureKey && !isEnabled(pageFeatureKey)) {
    return <Navigate to="/feature-toggles" replace />;
  }

  const isChat = location.pathname === '/chat';

  // Lazy-mount ChatPage: only instantiate after the user first visits /chat,
  // then keep it alive across navigation so in-progress flows survive.
  const chatMountedRef = useRef(false);
  if (isChat) chatMountedRef.current = true;
  const chatMounted = chatMountedRef.current;

  return (
    <div className="flex h-full overflow-hidden bg-gradient-to-br from-[#F7FAFF] via-[#EEF4FF] to-[#DDE8FF]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main className={`flex-1 ${isChat ? 'overflow-hidden' : 'overflow-y-auto p-6'} relative`}>
          {chatMounted && (
            <div className={isChat ? 'h-full' : 'hidden'}>
              <ChatPage />
            </div>
          )}
          {!isChat && <Outlet />}
        </main>
        <footer className="px-4 py-1.5 text-[11px] text-center text-gray-500 border-t border-gray-200 bg-white/60 backdrop-blur-sm">
          Copyright &copy; Jade Business Solutions LLC.
        </footer>
      </div>
    </div>
  );
}
