import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { signupUser } from '@/services/api';
import { Eye, EyeOff, AlertCircle, Zap, UserPlus, ChevronDown } from 'lucide-react';
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
    <div className="min-h-screen flex">
      {/* Left Panel — Background Image */}
      <div className="hidden lg:flex lg:w-[55%] relative overflow-hidden flex-col justify-between p-12">
        <div className="absolute inset-0 bg-cover bg-center bg-no-repeat" style={{ backgroundImage: "url('/JBSLoginPage.png')" }} />
        <div className="absolute inset-0 bg-[#0B0F1A]/40" />
        <div className="relative z-10">
          <img src="/jbs-logo-main.png" alt="JBS" className="h-16 w-auto" />
        </div>
        <div /><div />
      </div>

      {/* Right Panel */}
      <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-[#F5F3FF] via-white to-[#EDE9FE] p-8 relative overflow-y-auto">
        <div className="absolute inset-0 opacity-[0.02]" style={{ backgroundImage: 'radial-gradient(circle, #7C3AED 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

        <div className="relative w-full max-w-md">
          {/* Mobile logo */}
          <div className="lg:hidden text-center mb-8">
            <div className="bg-[#1E1B4B] rounded-2xl p-4 inline-block">
              <img src="/jbs-logo-main.png" alt="JBS" className="h-10 w-auto mx-auto" />
            </div>
            <p className="text-[9px] font-semibold tracking-[0.15em] text-[#7C3AED] uppercase mt-2">IntelliQE Assistant</p>
          </div>

          {/* Heading */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-[#1E1B4B]">
              {isSignUp ? 'Create Account' : 'Welcome'}
            </h2>
            {isSignUp && <p className="text-sm text-[#6B7280] mt-1">Fill in the details to get started</p>}
          </div>

          {/* Card */}
          <div className="bg-white/80 backdrop-blur-xl border border-[#DDD6FE] rounded-2xl p-8 shadow-xl shadow-purple-500/5">

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

          <div className="text-center mt-6">
            <p className="text-xs text-gray-400">&copy; Jade Business Solutions LLC.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
