/**
 * GettingStartedGuide — a plain-language "Start here" roadmap for the Overview.
 *
 * API test automation is unfamiliar to most first-time users: they land on a
 * dashboard full of numbers with no idea what to press first. This panel turns
 * the whole workflow — Import → Pick → Generate → Run → Report — into five
 * numbered steps written for someone with zero testing background. Each step
 * explains *what* and *why* in one sentence, ticks itself off as the workspace
 * fills up, and the first unfinished step lights up with a single next action.
 *
 * Purely additive: it reads existing catalogue + KPI state, drives the shell's
 * existing `onNavigate`, and never blocks anything. Experienced users collapse
 * it to a one-line progress strip (remembered in localStorage).
 */
import { useState } from 'react';
import {
  Upload, MousePointerClick, Sparkles, PlayCircle, BarChart3,
  Check, ChevronDown, Compass, ArrowRight, PartyPopper,
} from 'lucide-react';
import { CARD } from '../format';
import type { ApiOverview, NavView } from '../types';
import type { Catalog } from '../hooks/useCatalog';

interface Props {
  catalog: Catalog;
  kpis: ApiOverview['kpis'] | undefined;
  onNavigate: (v: NavView, toolsSearch?: string) => void;
}

const COLLAPSE_KEY = 'intelliqe_api_guide_collapsed';

interface Step {
  n: number;
  icon: React.ElementType;
  title: string;
  /** One sentence, written for a complete beginner — what this step does. */
  blurb: string;
  /** The one action that moves them forward. */
  cta: string;
  go: () => void;
  done: boolean;
}

export default function GettingStartedGuide({ catalog, kpis, onNavigate }: Props) {
  // Open by default so a first-time user always sees the map; once they collapse
  // it to the slim strip that choice is remembered and wins on every return.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; }
    catch { return false; }
  });
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const imported = catalog.endpoints.length > 0 || (kpis?.imports ?? 0) > 0;
  const picked = catalog.selected.size > 0;
  const generated = (kpis?.scenarios ?? 0) > 0;
  const ran = (kpis?.runs ?? 0) > 0;

  const steps: Step[] = [
    {
      n: 1, icon: Upload, title: 'Import your API',
      blurb: 'Bring your API in — upload a file or paste a link. We read OpenAPI, Postman, cURL, GraphQL and more.',
      cta: 'Import an API', go: () => onNavigate('import'), done: imported,
    },
    {
      n: 2, icon: MousePointerClick, title: 'Pick what to test',
      blurb: 'Open your catalogue and tick the endpoints you care about. No need to understand every one.',
      cta: 'Open catalogue', go: () => onNavigate('endpoints'), done: picked || generated,
    },
    {
      n: 3, icon: Sparkles, title: 'Let AI write the tests',
      blurb: 'The AI designs test scenarios for you — happy paths, edge cases and security checks. Zero scripting.',
      cta: 'Design scenarios', go: () => onNavigate('endpoints'), done: generated,
    },
    {
      n: 4, icon: PlayCircle, title: 'Run the suite',
      blurb: 'Press run. The platform executes every test and automatically repairs the ones that break.',
      cta: 'Go to Runs', go: () => onNavigate('runs'), done: ran,
    },
    {
      n: 5, icon: BarChart3, title: 'Read your report',
      blurb: 'See pass rates and issues explained in plain language, then share or export in one click.',
      cta: 'View reports', go: () => onNavigate('report'), done: ran,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  // The step to spotlight: the first one not yet done (the user's "you are here").
  const currentIdx = steps.findIndex((s) => !s.done);

  return (
    <div className={`${CARD} overflow-hidden`}>
      {/* ── Header — always visible; doubles as the collapsed strip ── */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#FBFAFF] transition-colors"
      >
        <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center flex-shrink-0 shadow-sm shadow-purple-500/25">
          {allDone ? <PartyPopper className="w-[18px] h-[18px] text-white" /> : <Compass className="w-[18px] h-[18px] text-white" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold text-gray-900 flex items-center gap-2">
            {allDone ? "You've got the basics 🎉" : 'New here? Get your first test running in 5 steps'}
          </h3>
          <p className="text-[11.5px] text-gray-500 mt-0.5 truncate">
            {allDone
              ? 'You can reopen this walkthrough any time.'
              : 'No code, no setup — follow the path and the platform does the hard part.'}
          </p>
        </div>
        {/* Progress — a compact "x of 5" with a track, readable even when collapsed */}
        <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
          <div className="w-24 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-[#7C3AED] to-[#6366F1] transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <span className="text-[11px] font-semibold text-gray-500 tabular-nums">{doneCount}/5</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>

      {/* ── Steps — the roadmap ── */}
      {!collapsed && (
        <div className="px-4 pb-4 pt-1">
          <ol className="relative grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2.5">
            {steps.map((s, i) => {
              const isCurrent = i === currentIdx;
              return (
                <li key={s.n}>
                  <div
                    className={`group relative h-full rounded-xl border p-3 flex flex-col transition-all ${
                      s.done
                        ? 'border-emerald-100 bg-emerald-50/40'
                        : isCurrent
                          ? 'border-[#DDD6FE] bg-[#F7F5FF] ring-1 ring-[#DDD6FE] shadow-sm'
                          : 'border-gray-100 bg-gray-50/40'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {/* Number badge, or a tick once the step is done */}
                      <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-[12px] font-bold ${
                        s.done
                          ? 'bg-emerald-500 text-white'
                          : isCurrent
                            ? 'bg-[#7C3AED] text-white'
                            : 'bg-white border border-gray-200 text-gray-400'
                      }`}>
                        {s.done ? <Check className="w-4 h-4" /> : s.n}
                      </span>
                      <s.icon className={`w-4 h-4 flex-shrink-0 ${s.done ? 'text-emerald-500' : isCurrent ? 'text-[#7C3AED]' : 'text-gray-400'}`} />
                      {isCurrent && !s.done && (
                        <span className="ml-auto text-[9px] font-bold uppercase tracking-wide text-[#6D28D9] bg-white border border-[#DDD6FE] rounded-full px-1.5 py-0.5">You're here</span>
                      )}
                    </div>
                    <h4 className={`mt-2 text-[12.5px] font-semibold ${s.done ? 'text-emerald-800' : 'text-gray-900'}`}>{s.title}</h4>
                    <p className="mt-1 text-[11px] leading-relaxed text-gray-500 flex-1">{s.blurb}</p>
                    <button
                      type="button"
                      onClick={s.go}
                      className={`mt-2.5 inline-flex items-center gap-1 text-[11.5px] font-semibold transition-colors ${
                        isCurrent && !s.done
                          ? 'text-white bg-gradient-to-r from-[#7C3AED] to-[#6366F1] px-2.5 py-1.5 rounded-lg shadow-sm shadow-purple-500/25 hover:-translate-y-0.5 self-start'
                          : s.done
                            ? 'text-emerald-700 hover:text-emerald-800'
                            : 'text-[#7C3AED] hover:text-[#5B21B6]'
                      }`}
                    >
                      {s.done ? 'Revisit' : s.cta}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>

          {/* A gentle reassurance line — beginners worry they'll break something */}
          <p className="mt-3 text-[11px] text-gray-400 flex items-center gap-1.5">
            <Sparkles className="w-3 h-3 text-[#A78BFA] flex-shrink-0" />
            Nothing here is permanent — you can re-import, re-generate and re-run as often as you like.
          </p>
        </div>
      )}
    </div>
  );
}
