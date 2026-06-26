import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function LandingPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const handleGetStarted = () => {
    navigate(isAuthenticated ? '/chat' : '/login');
  };

  return (
    <div className="min-h-screen flex flex-col text-white relative">
      {/* Full-screen background image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/JBS-dashboard.png')" }}
      />
      {/* Dark overlay — lighter on left to show dashboard, heavier on right for text readability */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#0B0F1A]/30 via-[#0B0F1A]/50 to-[#0B0F1A]/95" />
      {/* Top/bottom vignette for depth */}
      <div className="absolute inset-0 bg-gradient-to-t from-[#0B0F1A] via-transparent to-[#0B0F1A]/60" />

      {/* ── Logo only ── */}
      <div className="relative z-10 px-8 pt-8">
        <img src="/jbs-logo-main.png" alt="JBS" className="h-16 w-auto" />
      </div>

      {/* ── Hero — Right side, dashboard visible on left ── */}
      <main className="relative z-10 flex-1 flex items-center px-10">
        <div className="w-full flex">
          <div className="w-1/2 flex-shrink-0" />
          <div className="w-1/2 pl-6 pr-4">
            <span className="inline-block px-6 py-1.5 border border-violet-400/50 bg-violet-500/10 rounded-full text-sm text-violet-200 tracking-wide mb-6">
              Introducing
            </span>

            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold leading-[1.08] tracking-tight">
              <span className="bg-gradient-to-r from-violet-400 via-indigo-400 to-indigo-300 bg-clip-text text-transparent">
                IntelliQE
              </span>{' '}
              <span className="text-3xl sm:text-4xl lg:text-5xl text-white/90 font-semibold">
                By JBS
              </span>
            </h1>

            <p className="text-lg sm:text-xl text-gray-200 mt-5 font-bold leading-relaxed">
              Orchestrating the Future of Autonomous Quality
            </p>

            <p className="text-sm sm:text-base text-gray-400 mt-3 leading-relaxed">
              IntelliQE is a self-driving quality engineering platform that leverages
              AI agents to design, execute, and self-heal tests across the entire
              software lifecycle.
            </p>

            <button
              onClick={handleGetStarted}
              className="group mt-10 inline-flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-semibold text-base rounded-2xl transition-all shadow-2xl shadow-violet-500/25 hover:shadow-violet-500/40"
            >
              Start Testing
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>
          </div>
        </div>
      </main>

      {/* ── Copyright text ── */}
      <div className="relative z-10 py-4 px-6 text-center">
        <span className="text-xs text-gray-600">&copy; Jade Business Solutions LLC.</span>
      </div>
    </div>
  );
}
