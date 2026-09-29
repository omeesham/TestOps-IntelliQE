import { Outlet, useLocation } from 'react-router-dom';
import { useRef } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import ChatPage from '@/pages/ChatPage';
import ApiStudio from '@/components/api-studio/ApiStudio';
import { useFeature } from '@/contexts/FeatureToggleContext';
import FeatureUnavailable from '@/components/FeatureUnavailable';

export default function Layout() {
  const location = useLocation();
  // Chat and Web Application Automation are two views of the same ChatPage.
  const isChat = location.pathname === '/chat' || location.pathname === '/web-automation';
  // API Automation is a full-height, app-like surface (like Chat): it manages
  // its own scroll and chrome, so the shell gives it the full bleed — no page
  // padding, no outer scroll.
  const isApi = location.pathname.startsWith('/automation');
  const isFullBleed = isChat || isApi;
  const chatEnabled = useFeature('chat');
  const apiEnabled = useFeature('api-automation');

  // Lazy-mount ChatPage: only instantiate after the user first visits /chat,
  // then keep it alive across navigation so in-progress flows survive.
  // If Chat is disabled for this role, don't mount it at all.
  const chatMountedRef = useRef(false);
  if (isChat && chatEnabled) chatMountedRef.current = true;
  const chatMounted = chatMountedRef.current && chatEnabled;

  // API Automation gets the same treatment: an API run executes as a background
  // job the workspace polls, so unmounting the page on navigation would drop the
  // in-flight run and reset the user's position (which tab, the designed
  // scenarios, the live rows). Mount it once, on first visit, then keep it alive
  // and just hide it — the run keeps polling and the position is exactly restored.
  const apiMountedRef = useRef(false);
  if (isApi && apiEnabled) apiMountedRef.current = true;
  const apiMounted = apiMountedRef.current && apiEnabled;

  return (
    <div className="flex h-full overflow-hidden bg-[#F5F3FF]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main className={`flex-1 ${isFullBleed ? 'overflow-hidden' : 'overflow-y-auto p-6'} relative`}>
          {chatMounted && (
            <div className={isChat ? 'h-full' : 'hidden'}>
              <ChatPage />
            </div>
          )}
          {isChat && !chatEnabled && <FeatureUnavailable name="Chat" />}
          {apiMounted && (
            <div className={isApi ? 'h-full' : 'hidden'}>
              <ApiStudio />
            </div>
          )}
          {isApi && !apiEnabled && <FeatureUnavailable name="API Automation" />}
          {!isChat && !isApi && <Outlet />}
        </main>
        <footer className="px-4 py-1.5 text-[11px] text-center text-gray-500 border-t border-gray-200 bg-white/60 backdrop-blur-sm">
          &copy; 2026 JBS. All Rights Reserved.
        </footer>
      </div>
    </div>
  );
}
