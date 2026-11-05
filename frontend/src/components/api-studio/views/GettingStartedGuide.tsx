/**
 * GettingStartedGuide — a plain-language "Start here" roadmap for the Overview.
 *
 * API test automation is unfamiliar to most first-time users: they land on a
 * dashboard full of numbers with no idea what to press first. Five equal,
 * text-heavy cards in a row made that worse — nothing said *what to do now*,
 * and once every step was done the strip became a wall of identical green.
 *
 * This version uses a "map + spotlight" shape instead:
 *   • a connected progress stepper (the MAP) shows all five stages and exactly
 *     where you are — each dot is clickable, so any stage is one tap away;
 *   • one prominent SPOTLIGHT panel underneath always shows the single next
 *     action in plain English with one big button, so there is never any doubt
 *     about what to press next. When everything is done it turns into a short
 *     "you're set" panel with the obvious follow-ups.
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
import { CARD, PRIMARY_BTN, SECONDARY_BTN } from '../format';
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
  /** Full step name, shown in the spotlight panel. */
  title: string;
  /** One or two words, shown under the stepper dot. */
  short: string;
  /** One plain sentence — what this step does and why, for a total beginner. */
  blurb: string;
  /** The label on the step's action button. */
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
      n: 1, icon: Upload, title: 'Import your API', short: 'Import',
      blurb: 'Upload a file or paste a link — OpenAPI, Postman, cURL and GraphQL all work. We read the endpoints for you.',
      cta: 'Import an API', go: () => onNavigate('import'), done: imported,
    },
    {
      n: 2, icon: MousePointerClick, title: 'Pick what to test', short: 'Choose',
      blurb: "Tick the endpoints you want to cover. You don't need to understand every one — just pick what matters.",
      cta: 'Open catalogue', go: () => onNavigate('endpoints'), done: picked || generated,
    },
    {
      n: 3, icon: Sparkles, title: 'Let AI write the tests', short: 'AI writes',
      blurb: 'The AI designs the tests for you — normal cases, edge cases and security checks. No scripting at all.',
      cta: 'Design scenarios', go: () => onNavigate('endpoints'), done: generated,
    },
    {
      n: 4, icon: PlayCircle, title: 'Run the tests', short: 'Run',
      blurb: 'Press run. The platform executes every test and automatically repairs the ones that break.',
      cta: 'Go to Runs', go: () => onNavigate('runs'), done: ran,
    },
    {
      n: 5, icon: BarChart3, title: 'Read your report', short: 'Report',
      blurb: 'See pass rates and issues explained in plain English, then share or export them in one click.',
      cta: 'View reports', go: () => onNavigate('report'), done: ran,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  // The step to spotlight: the first one not yet done (the user's "you are here").
  const currentIdx = steps.findIndex((s) => !s.done);
  const current = currentIdx >= 0 ? steps[currentIdx] : null;

  return (
    <div className={`${CARD} overflow-hidden`}>
      {/* ── Header — always visible; doubles as the collapsed strip ── */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#FBFAFF] transition-colors"
      >
        <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center flex-shrink-0 shadow-sm shadow-purple-500/25">
          {allDone ? <PartyPopper className="w-5 h-5 text-white" /> : <Compass className="w-5 h-5 text-white" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold text-gray-900">
            {allDone ? "You're all set up 🎉" : 'How to run your first API test'}
          </h3>
          <p className="text-[12px] text-gray-500 mt-0.5 truncate">
            {allDone
              ? "You've done every step — reopen this walkthrough any time."
              : 'Five simple steps. No code, no setup — the platform does the hard part.'}
          </p>
        </div>
        {/* Progress — a compact "x of 5" with a track, readable even when collapsed */}
        <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
          <div className="w-28 h-2 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-[#7C3AED] to-[#6366F1] transition-all duration-500" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <span className="text-[12px] font-bold text-gray-500 tabular-nums">{doneCount}/5</span>
        </div>
        <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 pt-1">
          {/* ── The MAP — a connected stepper, every dot a shortcut to that stage ── */}
          <div className="flex items-start px-1 pt-1 pb-4">
            {steps.map((s, i) => {
              const isCurrent = i === currentIdx;
              // The connector arriving at this dot is "lit" once the step before it is done.
              const linkLit = i > 0 && steps[i - 1].done;
              return (
                <div key={s.n} className="contents">
                  {i > 0 && (
                    <div
                      className={`flex-1 h-[3px] mt-[18px] rounded-full transition-colors duration-500 ${
                        linkLit ? 'bg-emerald-400' : 'bg-gray-200'
                      }`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={s.go}
                    title={`Go to: ${s.title}`}
                    className="flex flex-col items-center w-14 sm:w-20 flex-shrink-0 group focus:outline-none"
                  >
                    <span
                      className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-[14px] font-bold transition-all group-hover:scale-105 ${
                        s.done
                          ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/30'
                          : isCurrent
                            ? 'bg-gradient-to-br from-[#7C3AED] to-[#6366F1] text-white shadow-md shadow-purple-500/30 ring-4 ring-[#EDE9FE]'
                            : 'bg-white border-2 border-gray-200 text-gray-400 group-hover:border-[#C4B5FD]'
                      }`}
                    >
                      {s.done ? <Check className="w-5 h-5" /> : s.n}
                    </span>
                    <span
                      className={`mt-2 text-[11px] font-semibold leading-tight text-center transition-colors ${
                        s.done ? 'text-emerald-700' : isCurrent ? 'text-[#6D28D9]' : 'text-gray-400 group-hover:text-gray-600'
                      }`}
                    >
                      {s.short}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* ── The SPOTLIGHT — one clear "do this next" panel ── */}
          {current ? (
            <div className="rounded-xl border border-[#DDD6FE] bg-gradient-to-br from-[#F7F5FF] to-[#F3F0FF] p-4 flex flex-col sm:flex-row sm:items-center gap-3.5">
              <span className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center flex-shrink-0 shadow-md shadow-purple-500/25">
                <current.icon className="w-6 h-6 text-white" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-[#7C3AED] bg-white border border-[#DDD6FE] rounded-full px-2 py-0.5">
                    Next · Step {current.n} of 5
                  </span>
                </div>
                <h4 className="mt-1.5 text-[15px] font-bold text-gray-900">{current.title}</h4>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-gray-600">{current.blurb}</p>
              </div>
              <button type="button" onClick={current.go} className={`${PRIMARY_BTN} flex-shrink-0 self-start sm:self-center whitespace-nowrap`}>
                {current.cta}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-[#F3F0FF] p-4 flex flex-col sm:flex-row sm:items-center gap-3.5">
              <span className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-emerald-500/25">
                <PartyPopper className="w-6 h-6 text-white" />
              </span>
              <div className="min-w-0 flex-1">
                <h4 className="text-[15px] font-bold text-gray-900">You've got the basics 🎉</h4>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-gray-600">
                  Your API is imported, tested and reported. From here you can dig into results or run the suite again whenever your API changes.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 self-start sm:self-center">
                <button type="button" onClick={() => onNavigate('report')} className={`${PRIMARY_BTN} whitespace-nowrap`}>
                  View reports <ArrowRight className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => onNavigate('runs')} className={`${SECONDARY_BTN} whitespace-nowrap`}>
                  Run again
                </button>
              </div>
            </div>
          )}

          {/* A gentle reassurance line — beginners worry they'll break something */}
          <p className="mt-3 text-[11.5px] text-gray-400 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-[#A78BFA] flex-shrink-0" />
            Nothing here is permanent — you can re-import, re-generate and re-run as often as you like.
          </p>
        </div>
      )}
    </div>
  );
}
