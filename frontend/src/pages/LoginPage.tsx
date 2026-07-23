import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { signupUser } from '@/services/api';
import { Eye, EyeOff, AlertCircle, Zap, UserPlus, Sparkles, ShieldCheck, Bot } from 'lucide-react';
import { normalizeError } from '@/utils/apiError';

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
  const { login } = useAuth();
  const navigate = useNavigate();

  const inputCls = 'w-full px-4 py-3 bg-[#F5F3FF] border border-[#DDD6FE] rounded-xl text-[#1E1B4B] placeholder:text-gray-400 text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/30 focus:border-[#7C3AED] transition-all';

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

  return (
    <div className="min-h-screen flex bg-[#0F0D26] relative overflow-hidden">
      {/* Animated aurora orbs — the living 3D backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="login-orb absolute -top-32 -left-24 w-[42rem] h-[42rem] rounded-full bg-[#7C3AED]/35 blur-[120px]" />
        <div className="login-orb absolute top-1/3 -right-32 w-[38rem] h-[38rem] rounded-full bg-[#6366F1]/30 blur-[120px]" style={{ animationDelay: '-6s' }} />
        <div className="login-orb absolute -bottom-40 left-1/3 w-[34rem] h-[34rem] rounded-full bg-[#06B6D4]/25 blur-[120px]" style={{ animationDelay: '-11s' }} />
      </div>

      {/* ── Left brand hero (lg+) ── */}
      <div className="hidden lg:flex flex-col justify-between w-[46%] xl:w-1/2 relative p-12 xl:p-16 text-white">
        <div className="login-rise" style={{ animationDelay: '0.05s' }}>
          <div className="inline-flex items-center gap-3">
            <div className="bg-white/10 backdrop-blur-md ring-1 ring-white/15 rounded-2xl p-3 shadow-[0_10px_30px_-8px_rgba(124,58,237,0.6)]">
              <img src="/jbs-logo-main.png" alt="JBS" className="h-9 w-auto" />
            </div>
            <span className="text-[11px] font-semibold tracking-[0.22em] text-violet-200/90 uppercase">IntelliQE Assistant</span>
          </div>
        </div>

        <div className="login-rise" style={{ animationDelay: '0.15s' }}>
          <h1 className="text-4xl xl:text-5xl font-extrabold leading-tight">
            AI-powered QA,
            <br />
            <span
              className="bg-clip-text text-transparent bg-[linear-gradient(110deg,#C4B5FD_20%,#ffffff_45%,#67E8F9_60%,#C4B5FD_80%)] bg-[length:220%_100%]"
              style={{ animation: 'loginShine 6s linear infinite' }}
            >
              from requirement to report.
            </span>
          </h1>
          <p className="mt-5 text-base text-violet-100/70 max-w-md">
            Generate, execute and self-heal your test suites with autonomous Claude agents — all in one intelligent workspace.
          </p>

          <div className="mt-9 space-y-4 max-w-md">
            {[
              { Icon: Bot, title: 'Autonomous test agents', desc: 'Plan, generate & heal tests end-to-end.' },
              { Icon: Sparkles, title: 'Live, self-healing runs', desc: 'Failures get diagnosed and fixed automatically.' },
              { Icon: ShieldCheck, title: 'Enterprise-ready', desc: 'Multi-tenant, secure, and audit-friendly.' },
            ].map(({ Icon, title, desc }, i) => (
              <div
                key={title}
                className="login-rise flex items-start gap-3.5 rounded-2xl bg-white/[0.06] backdrop-blur-md ring-1 ring-white/10 p-3.5 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.7)]"
                style={{ animationDelay: `${0.25 + i * 0.1}s` }}
              >
                <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center shadow-[inset_0_1px_1px_rgba(255,255,255,0.4),0_6px_14px_-4px_rgba(124,58,237,0.7)]">
                  <Icon className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{title}</p>
                  <p className="text-xs text-violet-100/60 mt-0.5">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="login-rise text-xs text-violet-200/40" style={{ animationDelay: '0.55s' }}>
          &copy; Jade Business Solutions LLC.
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-8 relative overflow-y-auto">
        <div className="login-card-3d relative w-full max-w-md">
          {/* Logo — compact on the form side (primary on mobile where the hero is hidden) */}
          <div className="text-center mb-7">
            <div className="bg-gradient-to-br from-[#312E81] to-[#1E1B4B] rounded-2xl p-4 inline-block shadow-[0_16px_40px_-12px_rgba(124,58,237,0.65),inset_0_1px_1px_rgba(255,255,255,0.2)]">
              <img src="/jbs-logo-main.png" alt="JBS" className="h-9 w-auto mx-auto" />
            </div>
            <p className="text-[9px] font-semibold tracking-[0.18em] text-violet-300 uppercase mt-2.5 lg:hidden">IntelliQE Assistant</p>
          </div>

          {/* Heading */}
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-bold text-white">
              {isSignUp ? 'Create Account' : 'Welcome back'}
            </h2>
            <p className="text-sm text-violet-200/60 mt-1">
              {isSignUp ? 'Fill in the details to get started' : 'Sign in to your IntelliQE workspace'}
            </p>
          </div>

          {/* Card */}
          <div className="bg-white/95 backdrop-blur-xl border border-white/40 rounded-3xl p-8 shadow-[0_30px_70px_-20px_rgba(10,8,40,0.85),inset_0_1px_1px_rgba(255,255,255,0.9)]">

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
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
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

                <button type="submit" disabled={isLoading || !username || !password} className="w-full py-3.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] disabled:from-[#C4B5FD] disabled:to-[#C7D2FE] disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40">
                  {isLoading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                      Signing in...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2"><Zap className="w-4 h-4" />Sign In</span>
                  )}
                </button>
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
                          ? 'border-[#7C3AED] bg-[#F5F3FF] shadow-sm shadow-purple-500/10'
                          : 'border-[#DDD6FE] bg-white hover:border-[#C4B5FD]'
                      }`}>
                        <input type="radio" name="role" value={r.value} checked={selectedRole === r.value} onChange={() => setSelectedRole(r.value)} className="sr-only" />
                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                          selectedRole === r.value ? 'border-[#7C3AED]' : 'border-gray-300'
                        }`}>
                          {selectedRole === r.value && <div className="w-2 h-2 rounded-full bg-[#7C3AED]" />}
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
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
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
                  <div className="flex items-center gap-2 p-3 bg-violet-50 border border-violet-200 rounded-xl">
                    <Zap className="w-4 h-4 text-violet-500 flex-shrink-0" />
                    <span className="text-sm text-violet-600">{success}</span>
                  </div>
                )}

                <button type="submit" disabled={isLoading || !fullName || !email || !username || !password || !confirmPassword} className="w-full py-3.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] disabled:from-[#C4B5FD] disabled:to-[#C7D2FE] disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40">
                  {isLoading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                      Creating account...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2"><UserPlus className="w-4 h-4" />Create Account</span>
                  )}
                </button>
              </form>
            )}

            {/* Toggle */}
            <div className="mt-6 pt-5 border-t border-[#EDE9FE] text-center">
              <p className="text-sm text-[#6B7280]">
                {isSignUp ? 'Already have an account?' : "Don't have an account?"}
                <button type="button" onClick={toggleMode} className="ml-1.5 text-[#7C3AED] font-semibold hover:text-[#6D28D9] transition-colors">
                  {isSignUp ? 'Sign In' : 'Create Account'}
                </button>
              </p>
            </div>
          </div>

          <div className="text-center mt-6 lg:hidden">
            <p className="text-xs text-violet-200/50">&copy; Jade Business Solutions LLC.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
