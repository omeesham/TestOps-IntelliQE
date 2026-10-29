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
import { normPath, endpointKey, resolveRefs } from './api-story-match.js';

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

/**
 * The trust label for what was captured about one endpoint, decided
 * deterministically from completeness, source strength and the model's own
 * grounding estimate — never set by the model directly:
 *
 *   SOURCE_BACKED    captured, traces back to a CONFIRMED source, little inferred
 *   INFERRED         captured, but leans on the endpoint's own definition
 *   MISSING          nothing testable was captured
 *   CONFLICTING      the requirement says two incompatible things about it
 *   REVIEW_REQUIRED  too thin or untraceable to trust without a person
 */
export type ReqClassification =
  | 'SOURCE_BACKED' | 'INFERRED' | 'MISSING' | 'CONFLICTING' | 'REVIEW_REQUIRED';

/** One disagreement found for an endpoint, and where it was seen. */
export interface ReqConflict {
  /** One line naming the contradiction. */
  summary: string;
  /** Flagged by the model from the text, or by a check over the responses. */
  origin: 'model' | 'responses';
}

/** What the agent captured about one endpoint it intends to test. */
export interface EndpointRequirement {
  method: string;
  url: string;
  /**
   * Stable, unique key for this requirement within a result — `METHOD url`.
   * Two endpoints can share a url (e.g. GET and POST /posts), so the url alone
   * is not a safe key; callers key review state and lists on this instead.
   */
  ref: string;
  purpose: string;
  inputs: ReqInput[];
  expectedResponses: ReqResponse[];
  businessRules: string[];
  /** Every source this endpoint traces back to, strongest first. */
  sources: ReqSourceRef[];
  /** The criteria that mapped onto this endpoint. */
  criteriaIds: string[];
  /** 5-state trust label, decided deterministically (see {@link ReqClassification}). */
  classification: ReqClassification;
  /**
   * 0–1 confidence in what was captured, reproducible from completeness,
   * source strength and the model's grounding estimate — not a raw model number.
   */
  confidence: number;
  /** Cross-source / within-requirement disagreements found for this endpoint. */
  conflicts: ReqConflict[];
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

/** The most recent sign-off recorded in the target environment, if any. */
export interface EnvSignoff {
  result: 'pass' | 'fail';
  passRate: number;
  signedAt: string;
  signedBy?: string;
}

/** What the caller knows that this service cannot work out for itself. */
export interface StoryContext {
  /** The environment the run would target, for the customer-similar + sign-off check. */
  environment?: { name: string; customerLike: boolean; latestSignoff?: EnvSignoff | null } | null;
  /** External refs already resolved from the story text (Jira, test management). */
  sources?: ReqSourceRef[];
}

const LAYERS = ['smoke', 'contract', 'schema', 'negative', 'auth', 'security', 'performance', 'flow'];
const COVERAGE = ['essential', 'standard', 'exhaustive'];
const KINDS = ['happy-path', 'negative', 'auth', 'validation', 'edge', 'other'];
const PARAM_IN = ['path', 'query', 'header', 'body'];

function endpointLines(endpoints: StoryEndpoint[], ids: string[]): string {
  return endpoints.slice(0, 80)
    .map((e, i) => `- [${ids[i]}] ${(e.method || 'GET').toUpperCase()} ${e.url}${e.title ? `  (${e.title})` : ''}`)
    .join('\n');
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
  req: Omit<EndpointRequirement, 'checklist' | 'ready' | 'classification' | 'confidence' | 'conflicts'>,
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
  const so = env?.latestSignoff || null;
  const signedDate = so ? String(so.signedAt).slice(0, 10) : '';

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
      label: 'Tested and signed off in a customer-similar environment',
      // Forward-looking at planning time — the environment must be customer-similar
      // — but now backed by the real sign-off record: a GREEN latest attestation
      // passes with evidence, a RED one fails with a caution, none keeps the
      // forward-looking pass (the run will be signed off against it).
      pass: !!env?.customerLike && (!so || so.result === 'pass'),
      detail: !env
        ? 'No environment selected, so the run cannot be signed off.'
        : !env.customerLike
          ? `“${env.name}” is not flagged customer-similar.`
          : so && so.result === 'pass'
            ? `“${env.name}” is customer-similar — last signed off green on ${signedDate} at ${so.passRate}%.`
            : so && so.result === 'fail'
              ? `“${env.name}” is customer-similar, but its last sign-off there failed (${signedDate}, ${so.passRate}%) — re-test and re-sign before release.`
              : `“${env.name}” is customer-similar — no sign-off recorded here yet; the run will be signed off against it.`,
    },
  ];
}

/** Roll the per-endpoint items up: an item holds only if it holds everywhere. */
function rollUp(requirements: EndpointRequirement[], context: StoryContext): ChecklistItem[] {
  const ids: ChecklistId[] = ['captured', 'source', 'reviewed', 'signed-off'];
  const labels = checkEndpoint(
    { method: '', url: '', ref: '', purpose: '', inputs: [], expectedResponses: [], businessRules: [], sources: [], criteriaIds: [] },
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

/** Normalise a condition string so two phrasings of the same case compare equal. */
function normWhen(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Deterministic conflict scan over the captured responses: the same condition
 * mapped to two different statuses is a contradiction the story cannot mean. The
 * model may also report conflicts it read in the text; those are merged in by the
 * caller. Nothing here invents disagreement — it only names what is already there.
 */
function responseConflicts(responses: ReqResponse[]): ReqConflict[] {
  const byWhen = new Map<string, Set<number>>();
  for (const r of responses) {
    const key = normWhen(r.when);
    if (!key) continue;
    (byWhen.get(key) || byWhen.set(key, new Set()).get(key)!).add(r.status);
  }
  const out: ReqConflict[] = [];
  for (const [, statuses] of byWhen) {
    if (statuses.size > 1) {
      const list = [...statuses].sort((a, b) => a - b);
      out.push({ summary: `The story asks for ${list.join(' and ')} on the same condition.`, origin: 'responses' });
    }
  }
  return out;
}

/** Is a given part of the requirement present? Inputs count as captured when the
 *  endpoint honestly takes none. */
function capturedParts(req: Omit<EndpointRequirement, 'checklist' | 'ready' | 'classification' | 'confidence' | 'conflicts'>, endpoint: StoryEndpoint) {
  const hasInputs = req.inputs.length > 0 || !takesInputs(endpoint);
  return {
    purpose: !!req.purpose,
    inputs: hasInputs,
    responses: req.expectedResponses.length > 0,
    rules: req.businessRules.length > 0,
  };
}

/**
 * Decide the 5-state label and a reproducible confidence from completeness, how
 * well the trace is confirmed, the model's grounding estimate and any conflict.
 * The model never sets the label — it only supplies a grounding hint and candidate
 * conflicts, the same stance the derived-source rule takes on provenance.
 */
function classify(
  req: Omit<EndpointRequirement, 'checklist' | 'ready' | 'classification' | 'confidence' | 'conflicts'>,
  endpoint: StoryEndpoint,
  grounding: number,
  conflicts: ReqConflict[],
): { classification: ReqClassification; confidence: number } {
  const parts = capturedParts(req, endpoint);
  const captured = [parts.purpose, parts.inputs, parts.responses, parts.rules].filter(Boolean).length;
  const completeness = captured / 4;
  const hasVerified = req.sources.some((s) => s.verified);
  const hasAnySource = req.sources.length > 0;
  const sourceScore = hasVerified ? 1 : hasAnySource ? 0.5 : 0;
  const g = Math.max(0, Math.min(1, Number.isFinite(grounding) ? grounding : 0.5));

  let classification: ReqClassification;
  if (conflicts.length) classification = 'CONFLICTING';
  else if (captured === 0) classification = 'MISSING';
  else if (captured <= 1) classification = 'REVIEW_REQUIRED';
  else if (hasVerified && g >= 0.6 && captured >= 3) classification = 'SOURCE_BACKED';
  else if (!hasAnySource) classification = 'REVIEW_REQUIRED';
  else classification = 'INFERRED';

  // Confidence: completeness + how confirmed the trace is + how grounded the
  // model says it is; a conflict caps it low, a hollow one lower still.
  let confidence = 0.45 * completeness + 0.3 * sourceScore + 0.25 * g;
  if (classification === 'CONFLICTING') confidence = Math.min(confidence, 0.4);
  if (classification === 'MISSING') confidence = Math.min(confidence, 0.15);
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

  return { classification, confidence };
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

  // Hand the model a short, stable id per endpoint (`e1`, `e2`, …) and have it
  // return the id — far more reliable than asking it to reproduce a long,
  // absolute, concretised URL verbatim. keyToId / pathToIds let us still resolve
  // a bare `GET /posts` or a path if the model answers in that form.
  const ids = endpoints.map((_, i) => `e${i + 1}`);
  const idToEp = new Map<string, StoryEndpoint>(ids.map((id, i) => [id, endpoints[i]]));
  const keyToId = new Map<string, string>();
  const pathToIds = new Map<string, string[]>();
  ids.forEach((id, i) => {
    const key = endpointKey(endpoints[i].method, endpoints[i].url);
    if (!keyToId.has(key)) keyToId.set(key, id);
    const p = normPath(endpoints[i].url);
    pathToIds.set(p, [...(pathToIds.get(p) || []), id]);
  });
  const resolve = (raw: unknown) => resolveRefs(raw, idToEp, keyToId, pathToIds);

  const prompt = `You are a senior SDET turning a product requirement (a Jira story, a PRD, or a user story with acceptance criteria) into an API test plan. Read the requirement, then respond with STRICT JSON only, no prose:
{"title": "<short title for the story, <=100 chars>",
 "summary": "<one sentence restating the goal, <=200 chars>",
 "criteria": [ { "text": "<one acceptance criterion restated as a testable statement, <=200 chars>",
                 "endpoints": [ "<ids of the catalogue endpoints this criterion exercises, e.g. \\"e2\\" — from the list below, [] if unclear>" ],
                 "testIdeas": [ "<=4 short imperative scenario titles, e.g. 'Reject checkout with an empty cart'>" ],
                 "kind": one of ${JSON.stringify(KINDS)} } ],
 "endpointRequirements": [ { "id": "<the id of a catalogue endpoint this story reaches, e.g. \\"e2\\", from the list below>",
                 "purpose": "<what this endpoint is for in this story, one sentence, <=200 chars>",
                 "inputs": [ { "name": "<field or parameter>", "in": one of ${JSON.stringify(PARAM_IN)}, "required": true|false, "note": "<what it means or constrains, <=120 chars>" } ],
                 "expectedResponses": [ { "status": <http status number>, "when": "<the condition that produces it, <=120 chars>" } ],
                 "businessRules": [ "<a rule the endpoint must honour, stated so it can be tested, <=160 chars>" ],
                 "grounding": <number 0..1 — how much of the four parts above is stated outright in the requirement vs inferred from the endpoint's own definition; 1 = every part is in the text, 0 = all inferred>,
                 "conflicts": [ "<a specific contradiction the requirement states about THIS endpoint, e.g. 'one rule rejects an over-limit cart with 409, another with 422' — [] when the text is consistent>" ] } ],
 "requirements": "<one focused paragraph (<=600 chars) a test generator can act on — the overall intent, the important cases, any constraints>",
 "coverage": one of ${JSON.stringify(COVERAGE)},
 "layers": array (subset of ${JSON.stringify(LAYERS)}) implied by the story }

Guidance: Extract EVERY distinct acceptance criterion as its own entry (a "Given/When/Then", a bullet, or an implied rule). Reference endpoints only by an id (e.g. "e2") from the catalogue below — never invent an id, and match the right HTTP method (the same path can appear as both a GET and a POST, which are different ids). Choose "exhaustive" coverage when the story stresses edge cases or many rules, "essential" for a single simple rule. Include "negative" when error/invalid paths are implied, "auth" for permissions, "flow" for multi-step lifecycles.

For endpointRequirements, write one entry for EVERY endpoint any criterion maps to. Capture all four parts: what it is for, what goes in, what should come back (success AND the error statuses the story implies), and the business rules it must honour. Ground every part in the requirement text — where the story is silent, say what the endpoint's own definition implies rather than inventing a rule. Set "grounding" honestly: low when you had to infer most of it, high when the text states it. Report a "conflict" only when the requirement genuinely says two incompatible things about the same endpoint — do not manufacture disagreement. Never state where the requirement came from; that is recorded separately.

REQUIREMENT:
${text}

ENDPOINT CATALOGUE:
${endpointLines(endpoints, ids) || '(none provided)'}

Return the JSON now.`;

  const res = await runLLM(prompt, { maxTokens: 6000, llm });
  let parsed: Record<string, any> = {};
  try { parsed = parseJsonFromResponse<Record<string, any>>(res) || {}; } catch { throw new Error('The model did not return a usable plan. Try a shorter or clearer story.'); }

  const rawCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  // Each criterion keeps its resolved endpoint ids internally (method-aware); the
  // public `endpoints` list is those endpoints' URLs, for display and the brief.
  const built = rawCriteria.slice(0, 40).map((c: any) => ({
    id: cid(),
    text: String(c?.text || '').slice(0, 200),
    refs: resolve(c?.endpoints),
    testIdeas: Array.isArray(c?.testIdeas) ? c.testIdeas.map((t: any) => String(t).slice(0, 160)).slice(0, 4) : [],
    kind: (KINDS.includes(String(c?.kind)) ? c.kind : 'other') as AcceptanceCriterion['kind'],
  })).filter((c: { text: string }) => c.text);

  const urlsOf = (refs: string[]) => [...new Set(refs.map((id) => idToEp.get(id)!.url))];
  const criteria: AcceptanceCriterion[] = built.map((c: { id: string; text: string; refs: string[]; testIdeas: string[]; kind: AcceptanceCriterion['kind'] }) => ({
    id: c.id,
    text: c.text,
    endpoints: urlsOf(c.refs).slice(0, 8),
    testIdeas: c.testIdeas,
    kind: c.kind,
  }));

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
  // Keyed by endpoint id, so a shared path with two methods (GET vs POST /posts)
  // stays two requirements; a true duplicate (same method+url) folds to one.
  const seenRef = new Set<string>();
  const reached: string[] = [];
  for (const id of [...new Set(built.flatMap((c: { refs: string[] }) => c.refs))] as string[]) {
    const e = idToEp.get(id)!;
    const ref = `${(e.method || 'GET').toUpperCase()} ${e.url}`;
    if (seenRef.has(ref)) continue;
    seenRef.add(ref);
    reached.push(id);
  }
  const facets = new Map<string, any>();
  for (const r of (Array.isArray(parsed.endpointRequirements) ? parsed.endpointRequirements : []).slice(0, 40)) {
    for (const id of resolve(r?.id ?? r?.url)) if (!facets.has(id)) facets.set(id, r);
  }

  const endpointRequirements: EndpointRequirement[] = reached.map((id) => {
    const endpoint = idToEp.get(id)!;
    const url = endpoint.url;
    const method = String(endpoint.method || 'GET').toUpperCase();
    const ref = `${method} ${url}`;
    const f = facets.get(id) || {};
    // The source is DERIVED, never read from the model: the story's own verified
    // external refs first, then this endpoint's import origin as the fallback.
    const origin = importOriginOf({ ...endpoint, source: endpoint.source });
    const sources: ReqSourceRef[] = [...(context.sources || []), ...(origin ? [origin] : [])];

    const base = {
      method,
      url,
      ref,
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
      criteriaIds: built.filter((c: { refs: string[] }) => c.refs.includes(id)).map((c: { id: string }) => c.id),
    };

    // Conflicts: what a check over the captured responses finds, plus any the
    // model read in the text — deduped, capped, each deterministic once parsed.
    const modelConflicts: ReqConflict[] = (Array.isArray(f.conflicts) ? f.conflicts : [])
      .map((c: any) => String(c || '').slice(0, 200).trim())
      .filter(Boolean)
      .map((summary: string): ReqConflict => ({ summary, origin: 'model' }));
    const conflicts: ReqConflict[] = [...responseConflicts(base.expectedResponses), ...modelConflicts]
      .filter((c, i, a) => a.findIndex((x) => normWhen(x.summary) === normWhen(c.summary)) === i)
      .slice(0, 6);
    const { classification, confidence } = classify(base, endpoint, Number(f.grounding), conflicts);

    const checklist = checkEndpoint(base, endpoint, context);
    return {
      ...base,
      classification,
      confidence,
      conflicts,
      checklist,
      ready: checklist.filter((c) => c.id === 'captured' || c.id === 'source').every((c) => c.pass),
    };
  });

  return {
    title: String(parsed.title || 'Story').slice(0, 100),
    summary: String(parsed.summary || '').slice(0, 200),
    criteria,
    brief,
    unmappedCriteria: built.filter((c: { refs: string[] }) => c.refs.length === 0).length,
    endpointRequirements,
    checklist: rollUp(endpointRequirements, context),
  };
}
