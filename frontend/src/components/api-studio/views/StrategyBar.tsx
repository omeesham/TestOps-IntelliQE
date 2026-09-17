/**
 * StrategyBar — the reviewer's steering wheel for generation.
 *
 * Depth (essential / standard / exhaustive) and the eight test layers, each
 * with the platform's estimate of how many cases it contributes for THIS
 * catalogue. "Use recommendation" adopts what the analysis suggested.
 */
import { Wand2, Check } from 'lucide-react';
import { CARD, SECONDARY_BTN } from '../format';
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
  { id: 'essential', label: 'Essential', hint: 'Smoke + the highest-value checks' },
  { id: 'standard', label: 'Standard', hint: 'Balanced — the default' },
  { id: 'exhaustive', label: 'Exhaustive', hint: 'Every layer, every variation' },
];

export default function StrategyBar({ strategy, profile, onCoverage, onToggleLayer, onAdopt }: {
  strategy: Strategy; profile: ApiProfile | null; onCoverage: (c: Strategy['coverage']) => void; onToggleLayer: (l: StrategyLayerId) => void; onAdopt: () => void;
}) {
  const layers: (StrategyLayer | typeof LAYER_FALLBACK[number])[] = profile?.strategy.layers?.length ? profile.strategy.layers : LAYER_FALLBACK;
  const estimated = profile?.strategy.layers?.filter((l) => strategy.layers.includes(l.id)).reduce((a, l) => a + l.estimatedCases, 0);
  const matchesRec = profile && strategy.coverage === profile.strategy.recommendedCoverage
    && profile.strategy.layers.every((l) => l.enabled === strategy.layers.includes(l.id));

  return (
    <div className={`${CARD} p-3.5`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Strategy</span>
        <div className="flex gap-0.5 bg-[#EEEBFA] rounded-md p-0.5 shadow-[inset_0_1px_3px_rgba(30,27,75,0.12)]">
          {COVERAGE.map((c) => (
            <button key={c.id} type="button" onClick={() => onCoverage(c.id)} title={c.hint} className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${strategy.coverage === c.id ? 'bg-gradient-to-b from-white to-[#FCFBFF] text-[#6D28D9] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(30,27,75,0.15)]' : 'text-gray-500 hover:text-gray-700'}`}>
              {c.label}{profile?.strategy.recommendedCoverage === c.id && <span className="ml-1 text-[9px] text-[#7C3AED]">●</span>}
            </button>
          ))}
        </div>
        {typeof estimated === 'number' && estimated > 0 && <span className="text-[11px] text-gray-500">≈ <span className="font-semibold text-gray-800 tabular-nums">{estimated}</span> cases estimated</span>}
        {profile && (
          <button type="button" onClick={onAdopt} disabled={!!matchesRec} className={`ml-auto ${SECONDARY_BTN}`}>
            {matchesRec ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Wand2 className="w-3.5 h-3.5" />}
            {matchesRec ? 'Using recommendation' : 'Use recommendation'}
          </button>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {layers.map((l) => {
          const on = strategy.layers.includes(l.id);
          const est = 'estimatedCases' in l ? l.estimatedCases : undefined;
          const applies = 'enabled' in l ? l.enabled : true;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => onToggleLayer(l.id)}
              title={l.rationale}
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-medium transition-all active:translate-y-px ${on ? 'bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] text-[#6D28D9] border-[#DDD6FE] shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_0_0_#DDD6FE,0_4px_8px_-6px_rgba(76,29,149,0.4)]' : 'bg-white text-gray-400 border-gray-200 hover:border-[#DDD6FE] shadow-[inset_0_1px_2px_rgba(30,27,75,0.06)]'} ${!applies && !on ? 'opacity-60' : ''}`}
            >
              <span className={`w-3 h-3 rounded-sm border flex items-center justify-center ${on ? 'bg-[#7C3AED] border-[#7C3AED]' : 'border-gray-300'}`}>{on && <Check className="w-2.5 h-2.5 text-white" />}</span>
              {l.label}
              {typeof est === 'number' && est > 0 && <span className="font-mono text-[10px] text-gray-400 tabular-nums">{est}</span>}
            </button>
          );
        })}
      </div>
      {profile?.strategy.rationale && <p className="mt-2 text-[10.5px] text-gray-400 leading-relaxed">{profile.strategy.rationale}</p>}
    </div>
  );
}
