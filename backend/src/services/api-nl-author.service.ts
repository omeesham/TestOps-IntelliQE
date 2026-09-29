/**
 * api-nl-author.service.ts
 * ────────────────────────
 * Natural-language test authoring — turn a plain-English description of what to
 * test into a structured brief the EXISTING generator already understands: a
 * requirements paragraph, a recommended coverage depth and layer set, and a
 * human-readable scenario outline.
 *
 * It produces a brief, not test cases. The design → generate → execute → heal
 * pipeline is untouched; the brief is applied to the run's strategy and fed to
 * the same generator, so nothing here bypasses or duplicates it.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export interface NlBriefEndpoint { method: string; url: string; title?: string }

export interface NlBrief {
  requirements: string;
  coverage: 'essential' | 'standard' | 'exhaustive';
  layers: string[];
  focus: string[];
  outline: string[];
}

const LAYERS = ['smoke', 'contract', 'schema', 'negative', 'auth', 'security', 'performance', 'flow'];
const COVERAGE = ['essential', 'standard', 'exhaustive'];

function endpointLines(endpoints: NlBriefEndpoint[]): string {
  return endpoints.slice(0, 60).map((e) => `- ${(e.method || 'GET').toUpperCase()} ${e.url}${e.title ? `  (${e.title})` : ''}`).join('\n');
}

export async function authorBrief(description: string, endpoints: NlBriefEndpoint[], llm: LlmConfig): Promise<NlBrief> {
  const desc = String(description || '').slice(0, 3000).trim();
  if (!desc) throw new Error('Describe what you want to test.');

  const prompt = `You are a senior SDET turning a plain-English testing request into a structured brief for an API test generator. Respond with STRICT JSON only, no prose:
{"requirements": "<one focused paragraph, <=600 chars, that a test generator can act on — restate the intent, the important cases, and any stated constraints>",
 "coverage": one of ${JSON.stringify(COVERAGE)},
 "layers": array (subset of ${JSON.stringify(LAYERS)}) — the test layers this request implies,
 "focus": array of endpoint URLs from the catalogue this most concerns (<=8, verbatim from the list, [] if it spans all),
 "outline": array of <=8 short scenario titles (imperative, e.g. "Reject an expired token")}

Guidance: pick "essential" for a quick smoke, "standard" for normal coverage, "exhaustive" when the request stresses edge cases or negatives. Include "negative" when invalid input/error paths are mentioned, "auth" for permissions/tokens, "security" for injection/authz probing, "performance" for load/latency, "flow" for multi-step lifecycles. Only reference endpoints that appear in the catalogue.

REQUEST:
${desc}

ENDPOINT CATALOGUE:
${endpointLines(endpoints) || '(none provided)'}

Return the JSON now.`;

  const res = await runLLM(prompt, { maxTokens: 900, llm });
  let parsed: Record<string, unknown> = {};
  try { parsed = parseJsonFromResponse<Record<string, unknown>>(res) || {}; } catch { /* fall back below */ }

  const coverage = COVERAGE.includes(String(parsed.coverage)) ? (parsed.coverage as NlBrief['coverage']) : 'standard';
  const layers = Array.isArray(parsed.layers) ? [...new Set(parsed.layers.map(String).filter((l) => LAYERS.includes(l)))] : [];
  const known = new Set(endpoints.map((e) => e.url));
  const focus = Array.isArray(parsed.focus) ? parsed.focus.map(String).filter((u) => known.has(u)).slice(0, 8) : [];
  const outline = Array.isArray(parsed.outline) ? parsed.outline.map((s) => String(s).slice(0, 160)).slice(0, 8) : [];
  const requirements = String(parsed.requirements || desc).slice(0, 600);

  return {
    requirements,
    coverage,
    // Always keep at least smoke so the brief yields a runnable strategy.
    layers: layers.length ? layers : ['smoke'],
    focus,
    outline,
  };
}
