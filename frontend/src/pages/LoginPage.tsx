import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { signupUser } from '@/services/api';
import { Eye, EyeOff, AlertCircle, Zap, UserPlus, ChevronDown } from 'lucide-react';
import { normalizeError } from '@/utils/apiError';

const ROLES = [
  { value: 'admin', label: 'Admin — full access to all modules' },
  { value: 'qa_engineer', label: 'QA Engineer — application & API testing' },
  { value: 'data_analyst', label: 'Data Analyst — data & AI validation' },
];

// Microsoft SSO entry point. When VITE_MS_SSO_URL is set (the backend's OAuth
// start endpoint, e.g. /api/auth/sso/microsoft), a "Continue with Microsoft"
// button appears on both forms and simply redirects there — the entire SSO
// conversion is: implement that endpoint + set this env var. Password forms
// keep working alongside it (or hide them behind the same flag if SSO-only).
const MS_SSO_URL: string | undefined = import.meta.env.VITE_MS_SSO_URL;

export default function LoginPage() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [selectedRole, setSelectedRole] = useState('qa_engineer');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const inputCls = 'w-full px-3.5 py-2.5 bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg text-[#1E1B4B] placeholder:text-gray-400 text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/30 focus:border-[#7C3AED] transition-all';
  const labelCls = 'block text-xs font-medium text-[#1E1B4B] mb-1';

  const resetForm = () => {
    setUsername('');
    setPassword('');
    setConfirmPassword('');
    setFullName('');
    setEmail('');
    setSelectedRole('qa_engineer');
    setError('');
    setSuccess('');
  };

  const toggleMode = () => {
    resetForm();
    setIsSignUp(!isSignUp);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const ok = await login(username, password);
      if (ok) {
        navigate('/chat');
      } else {
        setError('Invalid username or password.');
      }
    } catch (err) {
      // Surface the REAL reason — bad credentials vs server down vs network —
      // instead of a blanket "Invalid credentials".
      const n = normalizeError(err);
      setError(
        n.status === 401
          ? 'Invalid username or password.'
          : n.hint
            ? `${n.message} — ${n.hint}`
            : n.message,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }

    setIsLoading(true);
    try {
      await signupUser(username, password, fullName, email, selectedRole);
      setSuccess('Account created successfully!');
      setTimeout(() => { resetForm(); setIsSignUp(false); }, 1500);
    } catch (err) {
      const n = normalizeError(err);
      setError(n.hint ? `${n.message} ${n.hint}` : n.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMicrosoftSignIn = () => {
    if (MS_SSO_URL) window.location.href = MS_SSO_URL;
  };

  const spinner = (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
  );

  const microsoftButton = MS_SSO_URL && (
    <>
      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-[#EDE9FE]" />
        <span className="text-[11px] text-gray-400 uppercase tracking-wide">or</span>
        <div className="h-px flex-1 bg-[#EDE9FE]" />
      </div>
      <button type="button" onClick={handleMicrosoftSignIn} className="w-full py-2.5 border border-[#DDD6FE] rounded-lg bg-white hover:bg-[#F5F3FF] text-sm font-medium text-[#1E1B4B] flex items-center justify-center gap-2.5 transition-colors">
        <svg width="15" height="15" viewBox="0 0 21 21" aria-hidden="true">
          <rect x="1" y="1" width="9" height="9" fill="#F25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
          <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
          <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
        </svg>
        Continue with Microsoft
      </button>
    </>
  );

  return (
    // h-screen + overflow-y-auto on the OUTER element, and min-h-full (not
    // items-center on a fixed-height box) on the inner one: when the form is
    // taller than the viewport the page scrolls normally instead of clipping
    // the top of a centered card out of reach.
    <div className="h-screen overflow-y-auto bg-gradient-to-br from-[#F5F3FF] via-white to-[#EDE9FE]">
      <div className="min-h-full flex items-center justify-center p-6 relative">
        <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle, #7C3AED 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

        <div className="relative w-full max-w-md py-6">
          {/* Logo */}
          <div className="text-center mb-5">
            <div className="bg-[#1E1B4B] rounded-xl p-3 inline-block">
              <img src="/jbs-logo-main.png" alt="Logo" className="h-8 w-auto mx-auto" />
            </div>
            <p className="text-[9px] font-semibold tracking-[0.15em] text-[#7C3AED] uppercase mt-2">IntelliQE Assistant</p>
          </div>

          {/* Card */}
          <div className="bg-white/80 backdrop-blur-xl border border-[#DDD6FE] rounded-2xl p-6 shadow-xl shadow-purple-500/5">
            <div className="mb-5">
              <h2 className="text-xl font-bold text-[#1E1B4B]">
                {isSignUp ? 'Create Account' : 'Welcome'}
              </h2>
              {isSignUp && <p className="text-xs text-[#6B7280] mt-0.5">The first account on a new workspace becomes the admin.</p>}
            </div>

            {/* ── Sign In ── */}
            {!isSignUp && (
              <form onSubmit={handleSignIn} className="space-y-4">
                <div>
                  <label className={labelCls}>Username</label>
                  <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter username" autoComplete="username" autoFocus className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" autoComplete="current-password" className={inputCls + ' pr-10'} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-2.5 bg-red-50 border border-red-200 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <span className="text-sm text-red-600">{error}</span>
                  </div>
                )}

                <button type="submit" disabled={isLoading || !username || !password} className="w-full py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] disabled:from-[#C4B5FD] disabled:to-[#C7D2FE] disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold transition-all shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40">
                  {isLoading
                    ? <span className="flex items-center justify-center gap-2">{spinner}Signing in...</span>
                    : <span className="flex items-center justify-center gap-2"><Zap className="w-4 h-4" />Sign In</span>}
                </button>

                {microsoftButton}
              </form>
            )}

            {/* ── Sign Up ── */}
            {isSignUp && (
              <form onSubmit={handleSignUp} className="space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className={labelCls}>Full Name</label>
                    <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your full name" autoComplete="name" autoFocus className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Username</label>
                    <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Choose a username" autoComplete="username" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" className={inputCls} />
                </div>

                <div>
                  <label className={labelCls}>Role</label>
                  <div className="relative">
                    <select value={selectedRole} onChange={e => setSelectedRole(e.target.value)} className={inputCls + ' appearance-none pr-9 cursor-pointer'}>
                      {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className={labelCls}>Password</label>
                    <div className="relative">
                      <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Create a password" autoComplete="new-password" className={inputCls + ' pr-10'} />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Confirm Password</label>
                    <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Repeat password" autoComplete="new-password" className={inputCls} />
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-2.5 bg-red-50 border border-red-200 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <span className="text-sm text-red-600">{error}</span>
                  </div>
                )}
                {success && (
                  <div className="flex items-center gap-2 p-2.5 bg-violet-50 border border-violet-200 rounded-lg">
                    <Zap className="w-4 h-4 text-violet-500 flex-shrink-0" />
                    <span className="text-sm text-violet-600">{success}</span>
                  </div>
                )}

                <button type="submit" disabled={isLoading || !fullName || !email || !username || !password || !confirmPassword} className="w-full py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] disabled:from-[#C4B5FD] disabled:to-[#C7D2FE] disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold transition-all shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40">
                  {isLoading
                    ? <span className="flex items-center justify-center gap-2">{spinner}Creating account...</span>
                    : <span className="flex items-center justify-center gap-2"><UserPlus className="w-4 h-4" />Create Account</span>}
                </button>

                {microsoftButton}
              </form>
            )}

            {/* Toggle */}
            <div className="mt-5 pt-4 border-t border-[#EDE9FE] text-center">
              <p className="text-sm text-[#6B7280]">
                {isSignUp ? 'Already have an account?' : "Don't have an account?"}
                <button type="button" onClick={toggleMode} className="ml-1.5 text-[#7C3AED] font-semibold hover:text-[#6D28D9] transition-colors">
                  {isSignUp ? 'Sign In' : 'Create Account'}
                </button>
              </p>
            </div>
          </div>

          <div className="text-center mt-5">
            <p className="text-xs text-gray-400">&copy; 2026 JBS. All Rights Reserved.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
