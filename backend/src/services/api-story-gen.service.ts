/**
 * api-story-gen.service.ts
 * ────────────────────────
 * Requirement/story-driven generation. The NL author turns a free-form
 * description into a brief; this goes one step further and ingests a real
 * business artifact — a Jira story, a PRD, a user story with acceptance
 * criteria — then extracts each testable acceptance criterion, maps it to the
 * endpoints in the catalogue it most likely exercises, and emits a brief the
 * EXISTING generator already understands (same shape as the NL author's).
 *
 * Standalone and opt-in. It produces a brief + a criteria→endpoint map, not
 * test cases; the design → generate → execute → heal pipeline is untouched. An
 * LLM does the extraction; a deterministic pass validates and maps endpoints so
 * the model can never invent a URL that isn't in the catalogue.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';
import type { NlBrief } from './api-nl-author.service.js';

export interface StoryEndpoint { method: string; url: string; title?: string }

export interface AcceptanceCriterion {
  id: string;
  /** The criterion restated as a testable statement. */
  text: string;
  /** Catalogue endpoint URLs this criterion most likely exercises (verbatim). */
  endpoints: string[];
  /** Short, imperative scenario titles to generate for it. */
  testIdeas: string[];
  /** The kind of coverage this criterion implies. */
  kind: 'happy-path' | 'negative' | 'auth' | 'validation' | 'edge' | 'other';
}

export interface StoryGenResult {
  title: string;
  summary: string;
  criteria: AcceptanceCriterion[];
  /** A ready-to-apply strategy brief (same shape the NL author produces). */
  brief: NlBrief;
  /** How many criteria could not be tied to any catalogue endpoint. */
  unmappedCriteria: number;
}

const LAYERS = ['smoke', 'contract', 'schema', 'negative', 'auth', 'security', 'performance', 'flow'];
const COVERAGE = ['essential', 'standard', 'exhaustive'];
const KINDS = ['happy-path', 'negative', 'auth', 'validation', 'edge', 'other'];

function endpointLines(endpoints: StoryEndpoint[]): string {
  return endpoints.slice(0, 80).map((e) => `- ${(e.method || 'GET').toUpperCase()} ${e.url}${e.title ? `  (${e.title})` : ''}`).join('\n');
}

/**
 * Keep only the URLs the model picked that really exist in the catalogue. The
 * model is told to quote verbatim, but this is the hard guarantee — a mapped
 * endpoint is always one the user actually has.
 */
function keepKnown(urls: unknown, known: Set<string>): string[] {
  if (!Array.isArray(urls)) return [];
  return [...new Set(urls.map(String).filter((u) => known.has(u)))].slice(0, 8);
}

let seq = 0;
const cid = () => `ac-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export async function generateFromStory(story: string, endpoints: StoryEndpoint[], llm: LlmConfig): Promise<StoryGenResult> {
  const text = String(story || '').slice(0, 8000).trim();
  if (!text) throw new Error('Paste a story, PRD or acceptance criteria to generate from.');
  if (!llm) throw new Error('Story-driven generation needs an LLM — configure one under System Configuration → LLM, or an API-automation LLM provider.');

  const prompt = `You are a senior SDET turning a product requirement (a Jira story, a PRD, or a user story with acceptance criteria) into an API test plan. Read the requirement, then respond with STRICT JSON only, no prose:
{"title": "<short title for the story, <=100 chars>",
 "summary": "<one sentence restating the goal, <=200 chars>",
 "criteria": [ { "text": "<one acceptance criterion restated as a testable statement, <=200 chars>",
                 "endpoints": [ "<catalogue endpoint URLs this criterion exercises — VERBATIM from the list below, [] if unclear>" ],
                 "testIdeas": [ "<=4 short imperative scenario titles, e.g. 'Reject checkout with an empty cart'>" ],
                 "kind": one of ${JSON.stringify(KINDS)} } ],
 "requirements": "<one focused paragraph (<=600 chars) a test generator can act on — the overall intent, the important cases, any constraints>",
 "coverage": one of ${JSON.stringify(COVERAGE)},
 "layers": array (subset of ${JSON.stringify(LAYERS)}) implied by the story }

Guidance: Extract EVERY distinct acceptance criterion as its own entry (a "Given/When/Then", a bullet, or an implied rule). Only reference endpoint URLs that appear in the catalogue below — never invent one. Choose "exhaustive" coverage when the story stresses edge cases or many rules, "essential" for a single simple rule. Include "negative" when error/invalid paths are implied, "auth" for permissions, "flow" for multi-step lifecycles.

REQUIREMENT:
${text}

ENDPOINT CATALOGUE:
${endpointLines(endpoints) || '(none provided)'}

Return the JSON now.`;

  const res = await runLLM(prompt, { maxTokens: 3000, llm });
  let parsed: Record<string, any> = {};
  try { parsed = parseJsonFromResponse<Record<string, any>>(res) || {}; } catch { throw new Error('The model did not return a usable plan. Try a shorter or clearer story.'); }

  const known = new Set(endpoints.map((e) => e.url));
  const rawCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  const criteria: AcceptanceCriterion[] = rawCriteria.slice(0, 40).map((c: any) => ({
    id: cid(),
    text: String(c?.text || '').slice(0, 200),
    endpoints: keepKnown(c?.endpoints, known),
    testIdeas: Array.isArray(c?.testIdeas) ? c.testIdeas.map((t: any) => String(t).slice(0, 160)).slice(0, 4) : [],
    kind: (KINDS.includes(String(c?.kind)) ? c.kind : 'other') as AcceptanceCriterion['kind'],
  })).filter((c: AcceptanceCriterion) => c.text);

  const coverage = (COVERAGE.includes(String(parsed.coverage)) ? parsed.coverage : 'standard') as NlBrief['coverage'];
  let layers = Array.isArray(parsed.layers) ? [...new Set(parsed.layers.map(String).filter((l: string) => LAYERS.includes(l)))] : [];
  // Fold the criteria's kinds into the layer set so the brief reflects the story.
  if (criteria.some((c) => c.kind === 'negative' || c.kind === 'validation')) layers.push('negative');
  if (criteria.some((c) => c.kind === 'auth')) layers.push('auth');
  layers = [...new Set(layers)];
  const requirements = String(parsed.requirements || text).slice(0, 600);

  const brief: NlBrief = {
    requirements,
    coverage,
    layers: layers.length ? layers : ['smoke'],
    // Union of every criterion's mapped endpoints, capped — the focus of the run.
    focus: [...new Set(criteria.flatMap((c) => c.endpoints))].slice(0, 8),
    outline: criteria.flatMap((c) => c.testIdeas).slice(0, 8),
  };

  return {
    title: String(parsed.title || 'Story').slice(0, 100),
    summary: String(parsed.summary || '').slice(0, 200),
    criteria,
    brief,
    unmappedCriteria: criteria.filter((c) => c.endpoints.length === 0).length,
  };
}
