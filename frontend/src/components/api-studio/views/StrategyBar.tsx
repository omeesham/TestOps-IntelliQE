/**
 * StrategyBar — the reviewer's steering wheel for generation.
 *
 * Depth (essential / standard / exhaustive) and the eight test layers. Every
 * control states its consequence rather than its name alone: each layer says
 * what it produces and how many cases it contributes for THIS catalogue, and
 * the estimate is broken down so the reviewer can see where the number comes
 * from before committing an LLM run to it.
 */
import { Wand2, Check, Sparkles } from 'lucide-react';
import { CARD, SECONDARY_BTN, STRIP } from '../format';
import type { ApiProfile, Strategy, StrategyLayerId, StrategyLayer } from '../types';

const LAYER_FALLBACK: { id: StrategyLayerId; label: string; rationale: string }[] = [
  { id: 'smoke', label: 'Smoke', rationale: 'One happy-path request per endpoint' },
  { id: 'contract', label: 'Contract', rationale: 'Status, headers and response shape' },
  { id: 'schema', label: 'Schema', rationale: 'Field types, required fields, formats' },
  { id: 'negative', label: 'Negative', rationale: 'Invalid input, missing fields, bad ids' },
  { id: 'auth', label: 'Auth', rationale: 'Missing, expired and wrong-scope credentials' },
  { id: 'security', label: 'Security', rationale: 'Injection, IDOR, verbose errors' },
  { id: 'performance', label: 'Performance', rationale: 'Response-time budgets' },
  { id: 'flow', label: 'Flows', rationale: 'Multi-step lifecycles with real ids' },
];

const COVERAGE: { id: Strategy['coverage']; label: string; hint: string }[] = [
  { id: 'essential', label: 'Essential', hint: 'Smoke plus the highest-value checks — fastest to run, thinnest safety net' },
  { id: 'standard', label: 'Standard', hint: 'Balanced: the layers most APIs need, without the long tail' },
  { id: 'exhaustive', label: 'Exhaustive', hint: 'Every layer and every variation the analysis can justify' },
];

/** The violet–indigo ramp, one shade per layer, for the contribution bar. */
const SHADE: Record<StrategyLayerId, string> = {
  smoke: '#7C3AED', contract: '#8B5CF6', schema: '#A78BFA', negative: '#6366F1',
  auth: '#818CF8', security: '#4F46E5', performance: '#C4B5FD', flow: '#A5B4FC',
};

export default function StrategyBar({ strategy, profile, onCoverage, onToggleLayer, onAdopt }: {
  strategy: Strategy; profile: ApiProfile | null; onCoverage: (c: Strategy['coverage']) => void; onToggleLayer: (l: StrategyLayerId) => void; onAdopt: () => void;
}) {
  const layers: (StrategyLayer | typeof LAYER_FALLBACK[number])[] = profile?.strategy.layers?.length ? profile.strategy.layers : LAYER_FALLBACK;
  const selected = profile?.strategy.layers?.filter((l) => strategy.layers.includes(l.id)) || [];
  const estimated = profile ? selected.reduce((a, l) => a + l.estimatedCases, 0) : undefined;
  const recommended = profile?.strategy.estimatedTotal;
  const endpoints = profile?.totalEndpoints || 0;
  const perEndpoint = estimated && endpoints ? estimated / endpoints : 0;
  const matchesRec = profile && strategy.coverage === profile.strategy.recommendedCoverage
    && profile.strategy.layers.every((l) => l.enabled === strategy.layers.includes(l.id));
  const activeHint = COVERAGE.find((c) => c.id === strategy.coverage)?.hint;
  const mix = selected.filter((l) => l.estimatedCases > 0);

  return (
    <div className={`${CARD} overflow-hidden`}>
      {/* ── Depth ── */}
      <div className={`px-3.5 pt-3 pb-3 border-b border-[#EDE9FE] ${STRIP}`}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Strategy</span>
          {profile && <span className="ml-auto text-[9.5px] text-gray-400 inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#7C3AED]" />recommended</span>}
        </div>
        <div className="mt-2 flex gap-0.5 bg-[#EEEBFA] rounded-lg p-0.5 shadow-[inset_0_1px_3px_rgba(30,27,75,0.12)]">
          {COVERAGE.map((c) => (
            <button
              key={c.id} type="button" onClick={() => onCoverage(c.id)} title={c.hint}
              className={`flex-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${strategy.coverage === c.id
                ? 'bg-gradient-to-b from-white to-[#FCFBFF] text-[#6D28D9] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(30,27,75,0.15)]'
                : 'text-gray-500 hover:text-gray-700'}`}
            >
              {c.label}
              {profile?.strategy.recommendedCoverage === c.id && <span className="ml-1 text-[9px] text-[#7C3AED]" title="Recommended for this catalogue">●</span>}
            </button>
          ))}
        </div>
        {activeHint && <p className="mt-1.5 text-[10px] text-gray-400 leading-snug">{activeHint}</p>}
      </div>

      {/* ── What that adds up to ── */}
      {typeof estimated === 'number' && (
        <div className="px-3.5 py-2.5 border-b border-[#EDE9FE]">
          <div className="flex items-end gap-2 flex-wrap">
            <span className="font-mono text-[20px] font-semibold text-gray-900 tabular-nums leading-none">≈ {estimated}</span>
            <span className="text-[10.5px] text-gray-500 pb-0.5">cases from {endpoints} endpoint{endpoints === 1 ? '' : 's'}{perEndpoint > 0 ? ` · ~${perEndpoint.toFixed(perEndpoint < 10 ? 1 : 0)} each` : ''}</span>
          </div>

          {/* Where the number comes from, layer by layer. */}
          {mix.length > 0 && (
            <>
              <div className="mt-2 flex h-2 rounded-full overflow-hidden shadow-[inset_0_1px_2px_rgba(30,27,75,0.12)] bg-[#F3F1FB]">
                {mix.map((l) => (
                  <span key={l.id} title={`${l.label} · ${l.estimatedCases} case${l.estimatedCases === 1 ? '' : 's'}`} style={{ width: `${(l.estimatedCases / estimated) * 100}%`, background: SHADE[l.id] }} />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
                {mix.map((l) => (
                  <span key={l.id} className="inline-flex items-center gap-1 text-[9.5px] text-gray-500">
                    <span className="w-1.5 h-1.5 rounded-sm" style={{ background: SHADE[l.id] }} />
                    {l.label}<span className="font-mono tabular-nums text-gray-400">{l.estimatedCases}</span>
                  </span>
                ))}
              </div>
            </>
          )}

          {profile && (
            <div className="mt-2.5 flex items-center gap-2">
              <span className="text-[10px] text-gray-400 min-w-0 truncate">
                {matchesRec
                  ? 'Matching the analysis recommendation'
                  : <>Recommended: <span className="text-gray-600 font-medium">{profile.strategy.recommendedCoverage}</span>{typeof recommended === 'number' ? <> · ≈ {recommended} cases</> : null}</>}
              </span>
              <button type="button" onClick={onAdopt} disabled={!!matchesRec} className={`ml-auto flex-shrink-0 ${SECONDARY_BTN}`}>
                {matchesRec ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Wand2 className="w-3.5 h-3.5" />}
                {matchesRec ? 'In use' : 'Use it'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── The layers themselves ── */}
      <div className="px-2 py-2 space-y-0.5">
        {layers.map((l) => {
          const on = strategy.layers.includes(l.id);
          const est = 'estimatedCases' in l ? l.estimatedCases : undefined;
          const advised = 'enabled' in l ? l.enabled : undefined;
          const notAdvised = advised === false;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => onToggleLayer(l.id)}
              title={notAdvised && !on ? `${l.rationale} — the analysis did not recommend this layer for this catalogue` : l.rationale}
              className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-lg border text-left transition-all active:translate-y-px ${on
                ? 'bg-gradient-to-b from-[#F8F6FF] to-[#F3F0FE] border-[#DDD6FE] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_0_0_#E4DDFB]'
                : 'bg-white border-transparent hover:border-[#EDE9FE] hover:bg-[#FCFBFF]'}`}
            >
              <span className={`mt-px w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center flex-shrink-0 ${on ? 'bg-[#7C3AED] border-[#7C3AED] shadow-[0_1px_2px_rgba(76,29,149,0.4)]' : 'border-gray-300 bg-white shadow-[inset_0_1px_2px_rgba(30,27,75,0.08)]'}`}>
                {on && <Check className="w-2.5 h-2.5 text-white" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className={`text-[11.5px] font-medium ${on ? 'text-[#5B21B6]' : notAdvised ? 'text-gray-400' : 'text-gray-600'}`}>{l.label}</span>
                  {advised && <span className="w-1.5 h-1.5 rounded-full bg-[#7C3AED] flex-shrink-0" title="Recommended for this catalogue" />}
                  <span className="ml-auto font-mono text-[10px] tabular-nums flex-shrink-0 text-gray-400">
                    {typeof est === 'number' && est > 0 ? `${est}` : <span className="text-gray-300">—</span>}
                  </span>
                </span>
                <span className={`block text-[10px] leading-snug ${on ? 'text-gray-500' : 'text-gray-400'}`}>{l.rationale}</span>
              </span>
            </button>
          );
        })}
      </div>

      {profile?.strategy.rationale && (
        <p className="px-3.5 pb-3 -mt-0.5 text-[10.5px] text-gray-400 leading-relaxed flex gap-1.5">
          <Sparkles className="w-3 h-3 text-[#C4B5FD] flex-shrink-0 mt-0.5" />
          <span>{profile.strategy.rationale}</span>
        </p>
      )}
    </div>
  );
}
