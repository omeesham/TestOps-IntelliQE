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
 * It also answers the four questions that must hold before any endpoint is
 * taken for testing — the readiness CHECKLIST:
 *
 *   1. captured    purpose, inputs, expected responses and business rules
 *   2. source      the requirement links back to a spec section or an issue key
 *   3. reviewed    a person has approved or rejected it before planning starts
 *   4. signed-off  the run will happen somewhere customer-similar
 *
 * Items 1 and 2 are settled here. Item 3 is a human step this service can only
 * report as pending — the caller flips it when a reviewer acts. Item 4 is
 * forward-looking: the attestation itself is made at release time against the
 * run, so what is checked here is that the environment could carry one.
 *
 * Standalone and opt-in. It produces a brief + a criteria→endpoint map, not
 * test cases; the design → generate → execute → heal pipeline is untouched. An
 * LLM does the extraction; a deterministic pass validates and maps endpoints so
 * the model can never invent a URL that isn't in the catalogue, and the source
 * link is derived rather than generated so it can never invent an issue key.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';
import type { NlBrief } from './api-nl-author.service.js';
import { importOriginOf, type ReqSourceRef } from './api-story-source.service.js';

export interface StoryEndpoint {
  method: string;
  url: string;
  title?: string;
  /** The spec's own operation id, when the document carried one. */
  operationId?: string;
  description?: string;
  /** Where this endpoint entered the catalogue — the tier-3 source link. */
  source?: { method?: string; name?: string };
  /** Used to tell "no inputs captured" from "this endpoint takes none". */
  pathParams?: { name?: string }[];
  queryParams?: { name?: string }[];
  body?: string;
}

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

export type ChecklistId = 'captured' | 'source' | 'reviewed' | 'signed-off';

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  pass: boolean;
  /** Why it passed, or precisely what is missing. */
  detail: string;
}

export interface ReqInput {
  name: string;
  in: 'path' | 'query' | 'header' | 'body';
  required: boolean;
  note?: string;
}

export interface ReqResponse {
  status: number;
  /** The condition that produces it. */
  when: string;
}

/** What the agent captured about one endpoint it intends to test. */
export interface EndpointRequirement {
  method: string;
  url: string;
  purpose: string;
  inputs: ReqInput[];
  expectedResponses: ReqResponse[];
  businessRules: string[];
  /** Every source this endpoint traces back to, strongest first. */
  sources: ReqSourceRef[];
  /** The criteria that mapped onto this endpoint. */
  criteriaIds: string[];
  checklist: ChecklistItem[];
  /**
   * True when the agent did its own half: captured and sourced. Item 3 is the
   * reviewer's to give and item 4 belongs to the environment, so neither says
   * anything about whether THIS requirement is complete.
   */
  ready: boolean;
}

export interface StoryGenResult {
  title: string;
  summary: string;
  criteria: AcceptanceCriterion[];
  /** A ready-to-apply strategy brief (same shape the NL author produces). */
  brief: NlBrief;
  /** How many criteria could not be tied to any catalogue endpoint. */
  unmappedCriteria: number;
  /** One entry per endpoint the story actually reaches. */
  endpointRequirements: EndpointRequirement[];
  /** The four items rolled up across every endpoint above. */
  checklist: ChecklistItem[];
}

/** What the caller knows that this service cannot work out for itself. */
export interface StoryContext {
  /** The environment the run would target, for the customer-similar check. */
  environment?: { name: string; customerLike: boolean } | null;
  /** External refs already resolved from the story text (Jira, test management). */
  sources?: ReqSourceRef[];
}

const LAYERS = ['smoke', 'contract', 'schema', 'negative', 'auth', 'security', 'performance', 'flow'];
const COVERAGE = ['essential', 'standard', 'exhaustive'];
const KINDS = ['happy-path', 'negative', 'auth', 'validation', 'edge', 'other'];
const PARAM_IN = ['path', 'query', 'header', 'body'];

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

/** Does this endpoint take anything at all? An endpoint that takes nothing can
 *  honestly have no inputs captured; one that does cannot. */
function takesInputs(e: StoryEndpoint): boolean {
  return !!(e.pathParams?.length || e.queryParams?.length || (e.body && e.body.trim()));
}

let seq = 0;
const cid = () => `ac-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** The four items for one endpoint, each with the reason it reads as it does. */
function checkEndpoint(
  req: Omit<EndpointRequirement, 'checklist' | 'ready'>,
  endpoint: StoryEndpoint,
  context: StoryContext,
): ChecklistItem[] {
  const missing: string[] = [];
  if (!req.purpose) missing.push('purpose');
  if (!req.inputs.length && takesInputs(endpoint)) missing.push('inputs');
  if (!req.expectedResponses.length) missing.push('expected responses');
  if (!req.businessRules.length) missing.push('business rules');

  const env = context.environment;
  const verified = req.sources.filter((s) => s.verified);

  return [
    {
      id: 'captured',
      label: 'Purpose, inputs, expected responses and business rules captured',
      pass: missing.length === 0,
      detail: missing.length
        ? `Missing ${missing.join(', ')}.`
        : `${req.inputs.length} input${req.inputs.length === 1 ? '' : 's'}, ${req.expectedResponses.length} response${req.expectedResponses.length === 1 ? '' : 's'}, ${req.businessRules.length} rule${req.businessRules.length === 1 ? '' : 's'}.`,
    },
    {
      id: 'source',
      label: 'Links back to its source',
      pass: req.sources.length > 0,
      detail: !req.sources.length
        ? 'No issue key in the story and no import origin on this endpoint.'
        : verified.length
          ? `${verified[0].label} · ${verified[0].ref}`
          : `${req.sources[0].label} · ${req.sources[0].ref} — could not be confirmed.`,
    },
    {
      id: 'reviewed',
      label: 'Reviewed before planning starts',
      pass: false,
      detail: 'Waiting on a reviewer to approve or reject it.',
    },
    {
      id: 'signed-off',
      label: 'Will run somewhere customer-similar',
      pass: !!env?.customerLike,
      detail: !env
        ? 'No environment selected, so the run cannot be signed off.'
        : env.customerLike
          ? `“${env.name}” is flagged customer-similar.`
          : `“${env.name}” is not flagged customer-similar.`,
    },
  ];
}

/** Roll the per-endpoint items up: an item holds only if it holds everywhere. */
function rollUp(requirements: EndpointRequirement[], context: StoryContext): ChecklistItem[] {
  const ids: ChecklistId[] = ['captured', 'source', 'reviewed', 'signed-off'];
  const labels = checkEndpoint(
    { method: '', url: '', purpose: '', inputs: [], expectedResponses: [], businessRules: [], sources: [], criteriaIds: [] },
    { method: '', url: '' },
    context,
  );

  return ids.map((id, i) => {
    const label = labels[i].label;
    if (!requirements.length) {
      return { id, label, pass: false, detail: 'The story did not reach any endpoint in the catalogue.' };
    }
    const failed = requirements.filter((r) => !r.checklist.find((c) => c.id === id)?.pass);
    if (!failed.length) {
      return { id, label, pass: true, detail: `Holds for all ${requirements.length} endpoint${requirements.length === 1 ? '' : 's'}.` };
    }
    // When everything fails for the same reason the cause is global (no
    // environment, nobody has reviewed yet) — naming the endpoints is noise.
    const reasons = new Set(failed.map((r) => r.checklist.find((c) => c.id === id)?.detail || ''));
    if (failed.length === requirements.length && reasons.size === 1) {
      return { id, label, pass: false, detail: [...reasons][0] };
    }
    const names = failed.slice(0, 3).map((r) => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/i, '')}`);
    return {
      id,
      label,
      pass: false,
      detail: `${failed.length} of ${requirements.length} endpoint${requirements.length === 1 ? '' : 's'}: ${names.join(', ')}${failed.length > names.length ? '…' : ''}`,
    };
  });
}

export async function generateFromStory(
  story: string,
  endpoints: StoryEndpoint[],
  llm: LlmConfig,
  context: StoryContext = {},
): Promise<StoryGenResult> {
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
 "endpointRequirements": [ { "url": "<a catalogue endpoint URL this story reaches — VERBATIM>",
                 "purpose": "<what this endpoint is for in this story, one sentence, <=200 chars>",
                 "inputs": [ { "name": "<field or parameter>", "in": one of ${JSON.stringify(PARAM_IN)}, "required": true|false, "note": "<what it means or constrains, <=120 chars>" } ],
                 "expectedResponses": [ { "status": <http status number>, "when": "<the condition that produces it, <=120 chars>" } ],
                 "businessRules": [ "<a rule the endpoint must honour, stated so it can be tested, <=160 chars>" ] } ],
 "requirements": "<one focused paragraph (<=600 chars) a test generator can act on — the overall intent, the important cases, any constraints>",
 "coverage": one of ${JSON.stringify(COVERAGE)},
 "layers": array (subset of ${JSON.stringify(LAYERS)}) implied by the story }

Guidance: Extract EVERY distinct acceptance criterion as its own entry (a "Given/When/Then", a bullet, or an implied rule). Only reference endpoint URLs that appear in the catalogue below — never invent one. Choose "exhaustive" coverage when the story stresses edge cases or many rules, "essential" for a single simple rule. Include "negative" when error/invalid paths are implied, "auth" for permissions, "flow" for multi-step lifecycles.

For endpointRequirements, write one entry for EVERY endpoint any criterion maps to. Capture all four parts: what it is for, what goes in, what should come back (success AND the error statuses the story implies), and the business rules it must honour. Ground every part in the requirement text — where the story is silent, say what the endpoint's own definition implies rather than inventing a rule. Never state where the requirement came from; that is recorded separately.

REQUIREMENT:
${text}

ENDPOINT CATALOGUE:
${endpointLines(endpoints) || '(none provided)'}

Return the JSON now.`;

  const res = await runLLM(prompt, { maxTokens: 6000, llm });
  let parsed: Record<string, any> = {};
  try { parsed = parseJsonFromResponse<Record<string, any>>(res) || {}; } catch { throw new Error('The model did not return a usable plan. Try a shorter or clearer story.'); }

  const known = new Set(endpoints.map((e) => e.url));
  const byUrl = new Map(endpoints.map((e) => [e.url, e]));
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

  // ── The checklist: one requirement per endpoint the story actually reaches ──
  const reached = [...new Set(criteria.flatMap((c) => c.endpoints))];
  const facets = new Map<string, any>();
  for (const r of (Array.isArray(parsed.endpointRequirements) ? parsed.endpointRequirements : []).slice(0, 40)) {
    const url = String(r?.url || '');
    if (known.has(url)) facets.set(url, r);
  }

  const endpointRequirements: EndpointRequirement[] = reached.map((url) => {
    const endpoint = byUrl.get(url)!;
    const f = facets.get(url) || {};
    // The source is DERIVED, never read from the model: the story's own verified
    // external refs first, then this endpoint's import origin as the fallback.
    const origin = importOriginOf({ ...endpoint, source: endpoint.source });
    const sources: ReqSourceRef[] = [...(context.sources || []), ...(origin ? [origin] : [])];

    const base = {
      method: String(endpoint.method || 'GET').toUpperCase(),
      url,
      purpose: String(f.purpose || '').slice(0, 200),
      inputs: (Array.isArray(f.inputs) ? f.inputs : []).slice(0, 30).map((i: any): ReqInput => ({
        name: String(i?.name || '').slice(0, 80),
        in: (PARAM_IN.includes(String(i?.in)) ? i.in : 'body') as ReqInput['in'],
        required: !!i?.required,
        note: i?.note ? String(i.note).slice(0, 120) : undefined,
      })).filter((i: ReqInput) => i.name),
      expectedResponses: (Array.isArray(f.expectedResponses) ? f.expectedResponses : []).slice(0, 20).map((r: any): ReqResponse => ({
        status: Number(r?.status) || 0,
        when: String(r?.when || '').slice(0, 120),
      })).filter((r: ReqResponse) => r.status >= 100 && r.status <= 599),
      businessRules: (Array.isArray(f.businessRules) ? f.businessRules : []).map((b: any) => String(b).slice(0, 160)).filter(Boolean).slice(0, 20),
      sources,
      criteriaIds: criteria.filter((c) => c.endpoints.includes(url)).map((c) => c.id),
    };

    const checklist = checkEndpoint(base, endpoint, context);
    return {
      ...base,
      checklist,
      ready: checklist.filter((c) => c.id === 'captured' || c.id === 'source').every((c) => c.pass),
    };
  });

  return {
    title: String(parsed.title || 'Story').slice(0, 100),
    summary: String(parsed.summary || '').slice(0, 200),
    criteria,
    brief,
    unmappedCriteria: criteria.filter((c) => c.endpoints.length === 0).length,
    endpointRequirements,
    checklist: rollUp(endpointRequirements, context),
  };
}
