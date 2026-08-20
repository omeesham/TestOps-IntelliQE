import { Outlet, useLocation } from 'react-router-dom';
import { useRef } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import ChatPage from '@/pages/ChatPage';
import { useFeature } from '@/contexts/FeatureToggleContext';
import FeatureUnavailable from '@/components/FeatureUnavailable';

export default function Layout() {
  const location = useLocation();
  const isChat = location.pathname === '/chat';
  const chatEnabled = useFeature('chat');

  // Lazy-mount ChatPage: only instantiate after the user first visits /chat,
  // then keep it alive across navigation so in-progress flows survive.
  // If Chat is disabled for this role, don't mount it at all.
  const chatMountedRef = useRef(false);
  if (isChat && chatEnabled) chatMountedRef.current = true;
  const chatMounted = chatMountedRef.current && chatEnabled;

  return (
    <div className="flex h-full overflow-hidden bg-[#F5F3FF]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main className={`flex-1 ${isChat ? 'overflow-hidden' : 'overflow-y-auto p-6'} relative`}>
          {chatMounted && (
            <div className={isChat ? 'h-full' : 'hidden'}>
              <ChatPage />
            </div>
          )}
          {isChat && !chatEnabled && <FeatureUnavailable name="Chat" />}
          {!isChat && <Outlet />}
        </main>
        <footer className="px-4 py-1.5 text-[11px] text-center text-gray-500 border-t border-gray-200 bg-white/60 backdrop-blur-sm">
          &copy; 2026 JBS. All Rights Reserved.
        </footer>
      </div>
    </div>
  );
}
