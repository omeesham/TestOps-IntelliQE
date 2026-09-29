import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { normalizeError } from '@/utils/apiError';

/**
 * Landing page for the Microsoft SSO redirect.
 *
 * The backend callback sends the browser here with the session token in the
 * URL *fragment* (`#token=…&returnTo=…`) so it never reaches a server log.
 * We read it once, wipe it from the address bar, hydrate the auth context
 * from /api/auth/me and continue to the requested page.
 */
export default function SsoCallbackPage() {
  const { loginWithToken } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // React StrictMode double-invokes effects in dev
    ran.current = true;

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = params.get('token') || '';
    const returnTo = params.get('returnTo') || '';

    // Scrub the token from the URL/history immediately.
    window.history.replaceState(null, '', window.location.pathname);

    if (!token) {
      navigate('/login?sso_error=missing_token', { replace: true });
      return;
    }

    loginWithToken(token)
      .then(() => {
        const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/chat';
        navigate(safe, { replace: true });
      })
      .catch((err) => {
        const n = normalizeError(err);
        setError(n.hint ? `${n.message} — ${n.hint}` : n.message);
      });
  }, [loginWithToken, navigate]);

  return (
    <div className="h-screen flex items-center justify-center bg-gradient-to-br from-[#F5F3FF] via-white to-[#EDE9FE] p-6">
      <div className="w-full max-w-sm bg-white/80 backdrop-blur-xl border border-[#DDD6FE] rounded-2xl p-6 shadow-xl shadow-purple-500/5 text-center">
        {error ? (
          <>
            <div className="flex items-center gap-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-left">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <span className="text-sm text-red-600">{error}</span>
            </div>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              className="mt-4 text-sm text-[#7C3AED] font-semibold hover:text-[#6D28D9] transition-colors"
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <svg className="w-6 h-6 animate-spin mx-auto text-[#7C3AED]" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="mt-3 text-sm text-[#1E1B4B] font-medium">Signing you in with Microsoft…</p>
          </>
        )}
      </div>
    </div>
  );
}
