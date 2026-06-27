import { Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import ChatPage from '@/pages/ChatPage';

export default function Layout() {
  const location = useLocation();
  const isChat = location.pathname === '/chat';

  // Lazy-mount ChatPage: only instantiate after the user first visits /chat,
  // then keep it alive across navigation so in-progress flows survive. Lazy
  // init covers a direct load of /chat; the effect handles later navigation.
  // Sticky derived state: once /chat is visited it stays true. Setting state
  // during render (guarded) is React's recommended pattern here — no effect,
  // no ref-during-render.
  const [chatMounted, setChatMounted] = useState(isChat);
  if (isChat && !chatMounted) setChatMounted(true);

  return (
    <div className="flex h-full overflow-hidden bg-[#EFF5FF]">
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
