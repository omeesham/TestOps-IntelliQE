import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { signupUser } from '@/services/api';
import { Eye, EyeOff, AlertCircle, Zap, UserPlus } from 'lucide-react';
import { normalizeError } from '@/utils/apiError';
import Button from '@/components/ui/Button';

const ROLES = [
  { value: 'admin', label: 'JBS Admin', desc: 'Full access to all modules' },
  { value: 'qa_engineer', label: 'QA Engineer', desc: 'Application & API testing' },
  { value: 'data_analyst', label: 'Data Analyst', desc: 'Data & AI validation' },
];

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
  const { login, ssoLogin } = useAuth();
  const navigate = useNavigate();

  const ssoRedirectUri =
    (import.meta.env.VITE_AZURE_REDIRECT_URI as string | undefined) ||
    `${window.location.origin}/login`;

  // Complete the Entra ID SSO flow: Entra redirects back to /login?code=...
  // We hand the code to the backend for the server-side token exchange.
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const ssoError = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (ssoError) {
      setError(decodeURIComponent(ssoError));
      window.history.replaceState({}, '', '/login');
      return;
    }
    if (!code) return;

    // Verify the CSRF state matches what we issued before redirecting.
    const returnedState = url.searchParams.get('state');
    const expectedState = sessionStorage.getItem('sso_state');
    sessionStorage.removeItem('sso_state');
    if (!returnedState || returnedState !== expectedState) {
      setError('SSO sign-in could not be verified. Please try again.');
      window.history.replaceState({}, '', '/login');
      return;
    }

    setIsLoading(true);
    ssoLogin(code, ssoRedirectUri)
      .then((ok) => {
        if (ok) {
          navigate('/chat');
        } else {
          setError('SSO sign-in failed. Please try again.');
          window.history.replaceState({}, '', '/login');
        }
      })
      .finally(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputCls = 'w-full px-4 py-3 bg-[#EFF5FF] border border-[#C9DCFF] rounded-xl text-[#1E1B4B] placeholder:text-gray-400 text-sm outline-none focus:ring-2 focus:ring-[#155dfc]/30 focus:border-[#155dfc] transition-all';

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

  // Microsoft Entra ID (Azure AD) SSO — UI redirect flow.
  // Config via VITE_ env vars; backend callback handling is a follow-up (see /api/auth/sso/callback TODO).
  const handleSsoLogin = () => {
    const tenant = import.meta.env.VITE_AZURE_TENANT_ID as string | undefined;
    const clientId = import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined;
    if (!tenant || !clientId) {
      setError('SSO is not configured. Set VITE_AZURE_TENANT_ID and VITE_AZURE_CLIENT_ID.');
      return;
    }
    // CSRF guard: generate a random state, persist it, and verify it on return.
    const state = crypto.randomUUID();
    sessionStorage.setItem('sso_state', state);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: ssoRedirectUri,
      response_mode: 'query',
      scope: 'openid profile email',
      state,
    });
    window.location.href = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    const ok = await login(username, password);
    if (ok) {
      navigate('/chat');
    } else {
      setError('Invalid credentials. Please try again.');
    }
    setIsLoading(false);
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#EFF5FF] via-white to-[#DEEAFF] p-8 relative overflow-y-auto">
      <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: 'radial-gradient(circle, #155dfc 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src="/jbs-logo-dark.png" alt="JBS" className="h-12 w-auto mx-auto" />
          <p className="text-sm font-semibold tracking-[0.15em] text-[#155dfc] uppercase mt-2">IntelliQE Assistant</p>
        </div>

        {/* Heading */}
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-bold text-[#1E1B4B]">
            {isSignUp ? 'Create Account' : 'Welcome'}
          </h2>
          {isSignUp && <p className="text-sm text-[#6B7280] mt-1">Fill in the details to get started</p>}
        </div>

          {/* Card */}
          <div className="bg-white/80 backdrop-blur-xl border border-[#C9DCFF] rounded-2xl p-8 shadow-xl shadow-blue-500/5">

            {/* ── Sign In ── */}
            {!isSignUp && (
              <form onSubmit={handleSignIn} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Username</label>
                  <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter username" autoFocus className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" className={inputCls + ' pr-11'} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#155dfc] transition-colors">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <span className="text-sm text-red-600">{error}</span>
                  </div>
                )}

                <Button
                  type="submit"
                  size="lg"
                  isLoading={isLoading}
                  disabled={!username || !password}
                  leftIcon={!isLoading && <Zap className="w-4 h-4" />}
                  className="w-full"
                >
                  {isLoading ? 'Signing in...' : 'Sign In'}
                </Button>

                <div className="text-center">
                  <button type="button" onClick={handleSsoLogin} className="text-sm text-[#155dfc] font-semibold hover:text-[#155dfc] transition-colors">
                    Use single sign-on (SSO) instead
                  </button>
                </div>
              </form>
            )}

            {/* ── Sign Up ── */}
            {isSignUp && (
              <form onSubmit={handleSignUp} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Full Name</label>
                  <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Enter your full name" autoFocus className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter your email" className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Username</label>
                  <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Choose a username" className={inputCls} />
                </div>

                {/* Role Selection */}
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Role</label>
                  <div className="space-y-2">
                    {ROLES.map(r => (
                      <label key={r.value} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                        selectedRole === r.value
                          ? 'border-[#155dfc] bg-[#EFF5FF] shadow-sm shadow-blue-500/10'
                          : 'border-[#C9DCFF] bg-white hover:border-[#93B4FB]'
                      }`}>
                        <input type="radio" name="role" value={r.value} checked={selectedRole === r.value} onChange={() => setSelectedRole(r.value)} className="sr-only" />
                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                          selectedRole === r.value ? 'border-[#155dfc]' : 'border-gray-300'
                        }`}>
                          {selectedRole === r.value && <div className="w-2 h-2 rounded-full bg-[#155dfc]" />}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[#1E1B4B]">{r.label}</p>
                          <p className="text-[11px] text-gray-400">{r.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Create a password" className={inputCls + ' pr-11'} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#155dfc] transition-colors">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1.5">Confirm Password</label>
                  <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Confirm your password" className={inputCls} />
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <span className="text-sm text-red-600">{error}</span>
                  </div>
                )}
                {success && (
                  <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-xl">
                    <Zap className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    <span className="text-sm text-blue-600">{success}</span>
                  </div>
                )}

                <Button
                  type="submit"
                  size="lg"
                  isLoading={isLoading}
                  disabled={!fullName || !email || !username || !password || !confirmPassword}
                  leftIcon={!isLoading && <UserPlus className="w-4 h-4" />}
                  className="w-full"
                >
                  {isLoading ? 'Creating account...' : 'Create Account'}
                </Button>
              </form>
            )}

            {/* Toggle */}
            <div className="mt-6 pt-5 border-t border-[#DEEAFF] text-center">
              <p className="text-sm text-[#6B7280]">
                {isSignUp ? 'Already have an account?' : "Don't have an account?"}
                <button type="button" onClick={toggleMode} className="ml-1.5 text-[#155dfc] font-semibold hover:text-[#155dfc] transition-colors">
                  {isSignUp ? 'Sign In' : 'Create Account'}
                </button>
              </p>
            </div>
          </div>

        <div className="text-center mt-6">
          <p className="text-xs text-gray-400">&copy; Jade Business Solutions LLC.</p>
        </div>
      </div>
    </div>
  );
}
