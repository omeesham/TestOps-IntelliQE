/**
 * api-finops.service.ts
 * ─────────────────────
 * AI-cost / FinOps metering for a pipeline run. Estimates the token spend of a
 * generate → plan → script → execute → heal → audit run before it starts, prices
 * it against a per-model rate card, and enforces an optional hard cap (USD or
 * tokens) per run so an enterprise can meter and budget Claude/OpenAI/Gemini
 * spend the way it meters cloud cost.
 *
 * Standalone and opt-in: pure arithmetic over a cost model, no IO, no pipeline
 * coupling. The rate card is a sensible default an operator overrides — prices
 * are published list figures that drift, so they are editable inputs, not truth.
 */
export interface ModelRate {
  id: string;
  label: string;
  /** USD per 1M input (prompt) tokens. */
  inputPerM: number;
  /** USD per 1M output (completion) tokens. */
  outputPerM: number;
}

/** Default rate card (USD / 1M tokens). Editable — list prices drift. */
const RATE_CARD: ModelRate[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', inputPerM: 15, outputPerM: 75 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', inputPerM: 3, outputPerM: 15 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', inputPerM: 0.8, outputPerM: 4 },
  { id: 'gpt-4o', label: 'OpenAI GPT-4o', inputPerM: 2.5, outputPerM: 10 },
  { id: 'gpt-4o-mini', label: 'OpenAI GPT-4o mini', inputPerM: 0.15, outputPerM: 0.6 },
  { id: 'gemini-1.5-pro', label: 'Google Gemini 1.5 Pro', inputPerM: 1.25, outputPerM: 5 },
  { id: 'custom', label: 'Custom / self-hosted', inputPerM: 0, outputPerM: 0 },
];

/**
 * Per-stage token model. `base*` is the fixed cost of the stage (system prompt,
 * agent definition, strategy), `per*` scales with the endpoint count. A
 * complexity multiplier (0.5 lean … 2 thorough) scales the whole estimate.
 */
interface StageModel { id: string; label: string; baseIn: number; perIn: number; baseOut: number; perOut: number }
const STAGES: StageModel[] = [
  { id: 'requirement', label: 'Requirement parse', baseIn: 1500, perIn: 120, baseOut: 800, perOut: 60 },
  { id: 'planner', label: 'Test strategy', baseIn: 2200, perIn: 180, baseOut: 1200, perOut: 110 },
  { id: 'generator', label: 'Scenario generation', baseIn: 3000, perIn: 420, baseOut: 2600, perOut: 650 },
  { id: 'script', label: 'Script generation', baseIn: 2600, perIn: 380, baseOut: 2400, perOut: 700 },
  { id: 'execution', label: 'Execution triage', baseIn: 1400, perIn: 90, baseOut: 600, perOut: 50 },
  { id: 'audit', label: 'Quality audit', baseIn: 1800, perIn: 110, baseOut: 900, perOut: 70 },
];

export interface FinOpsStageCost {
  id: string; label: string;
  inputTokens: number; outputTokens: number;
  costUsd: number;
}
export interface FinOpsEstimate {
  model: ModelRate;
  endpoints: number;
  complexity: number;
  /** How many healing passes were priced in (1 = no heal). */
  iterations: number;
  stages: FinOpsStageCost[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  cap: { usd: number | null; tokens: number | null };
  within: boolean;
  overspend: { usd: number; tokens: number };
  /** The headroom a cap allows, or null when uncapped. */
  remaining: { usd: number | null; tokens: number | null };
  verdict: 'within-budget' | 'over-budget' | 'uncapped';
  notes: string[];
}

export interface EstimateInput {
  model?: string;
  rate?: { inputPerM?: number; outputPerM?: number };
  endpoints?: number;
  /** 0.5 (lean) … 2 (thorough). Defaults to 1. */
  complexity?: number;
  /** Total pipeline passes including the first; healing adds passes. */
  iterations?: number;
  capUsd?: number | null;
  capTokens?: number | null;
}

export function listModelRates(): ModelRate[] {
  return RATE_CARD.map((r) => ({ ...r }));
}

function round(n: number, dp = 4): number { const f = 10 ** dp; return Math.round(n * f) / f; }

export function estimateRunCost(input: EstimateInput): FinOpsEstimate {
  const endpoints = Math.max(0, Math.min(5000, Math.floor(Number(input.endpoints) || 0)));
  const complexity = Math.max(0.25, Math.min(3, Number(input.complexity) || 1));
  const iterations = Math.max(1, Math.min(10, Math.floor(Number(input.iterations) || 1)));

  const picked = RATE_CARD.find((r) => r.id === input.model) || RATE_CARD[0]!;
  const model: ModelRate = {
    ...picked,
    inputPerM: input.rate?.inputPerM != null ? Math.max(0, Number(input.rate.inputPerM)) : picked.inputPerM,
    outputPerM: input.rate?.outputPerM != null ? Math.max(0, Number(input.rate.outputPerM)) : picked.outputPerM,
  };

  const stages: FinOpsStageCost[] = STAGES.map((s) => {
    const inputTokens = Math.round((s.baseIn + s.perIn * endpoints) * complexity * iterations);
    const outputTokens = Math.round((s.baseOut + s.perOut * endpoints) * complexity * iterations);
    const costUsd = round((inputTokens / 1e6) * model.inputPerM + (outputTokens / 1e6) * model.outputPerM);
    return { id: s.id, label: s.label, inputTokens, outputTokens, costUsd };
  });

  const inputTokens = stages.reduce((a, s) => a + s.inputTokens, 0);
  const outputTokens = stages.reduce((a, s) => a + s.outputTokens, 0);
  const totalTokens = inputTokens + outputTokens;
  const costUsd = round(stages.reduce((a, s) => a + s.costUsd, 0), 2);

  const capUsd = input.capUsd != null && Number.isFinite(Number(input.capUsd)) ? Math.max(0, Number(input.capUsd)) : null;
  const capTokens = input.capTokens != null && Number.isFinite(Number(input.capTokens)) ? Math.max(0, Math.floor(Number(input.capTokens))) : null;

  const overUsd = capUsd != null ? Math.max(0, round(costUsd - capUsd, 2)) : 0;
  const overTokens = capTokens != null ? Math.max(0, totalTokens - capTokens) : 0;
  const within = (capUsd == null || costUsd <= capUsd) && (capTokens == null || totalTokens <= capTokens);
  const uncapped = capUsd == null && capTokens == null;

  const notes: string[] = [];
  if (uncapped) notes.push('No cap set — this run would not be gated on spend. Set a USD or token cap to meter it.');
  else if (!within) {
    if (overUsd > 0) notes.push(`Estimated $${costUsd.toFixed(2)} exceeds the $${capUsd!.toFixed(2)} cap by $${overUsd.toFixed(2)}.`);
    if (overTokens > 0) notes.push(`Estimated ${totalTokens.toLocaleString()} tokens exceeds the ${capTokens!.toLocaleString()} cap by ${overTokens.toLocaleString()}.`);
    notes.push('Lower complexity, reduce healing iterations, or split the endpoint set to land within budget.');
  }
  if (model.id === 'custom' && model.inputPerM === 0 && model.outputPerM === 0) notes.push('Custom model priced at $0 — enter your self-hosted / contract rate to meter real spend.');

  return {
    model, endpoints, complexity, iterations, stages,
    inputTokens, outputTokens, totalTokens, costUsd,
    cap: { usd: capUsd, tokens: capTokens },
    within,
    overspend: { usd: overUsd, tokens: overTokens },
    remaining: { usd: capUsd != null ? round(Math.max(0, capUsd - costUsd), 2) : null, tokens: capTokens != null ? Math.max(0, capTokens - totalTokens) : null },
    verdict: uncapped ? 'uncapped' : within ? 'within-budget' : 'over-budget',
    notes,
  };
}
