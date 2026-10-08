/**
 * api-heal.service.ts
 * ───────────────────
 * Intent-based (semantic) self-healing. The built-in healing loop and the drift
 * tool heal STRUCTURAL contract drift — a status or response shape that moved.
 * This goes further: for a failing test it re-observes the live endpoint and
 * asks the model to reason about INTENT — is this a genuine regression (a bug
 * the test correctly caught, do NOT rewrite it), an acceptable contract
 * evolution (adopt the new expectation, the test's purpose still holds), a
 * flaky/timing blip, or an environment/auth problem? — then proposes an
 * intent-preserving fix with a rationale and a confidence.
 *
 * Standalone and opt-in. It produces REVIEWABLE proposals; nothing is applied
 * automatically. It is non-destructive by default: write-method endpoints are
 * NOT re-fired live unless the caller explicitly allows it. The generate →
 * execute → heal pipeline is untouched.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';
import { buildRequestInit, fetchFull, isWriteMethod, type HttpEndpoint } from '../utils/api-http.js';

export interface HealFailure {
  endpointId?: string;
  title?: string;
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type?: string; value?: string; headerName?: string };
  body?: string;
  /** What the test asserted / what went wrong. */
  error?: string;
  expectedStatus?: number;
  expectedResponse?: string;
}

export type HealClassification = 'regression' | 'contract-evolution' | 'flaky' | 'environment' | 'auth' | 'unknown';

export interface HealProposal {
  endpointId?: string;
  title: string;
  method: string;
  url: string;
  classification: HealClassification;
  confidence: 'high' | 'medium' | 'low';
  /** True ONLY when the intent is preserved and adopting the new contract is safe. */
  shouldHeal: boolean;
  summary: string;
  rationale: string;
  observed?: { status?: number; reachable: boolean; bodySnippet?: string };
  /** The intent-preserving patch to adopt — present only when shouldHeal. */
  patch?: { expectedStatus?: number; expectedResponse?: string };
  /** Set when the endpoint could not be re-observed (e.g. a write, not re-fired). */
  note?: string;
}

export interface HealResult {
  proposals: HealProposal[];
  summary: { analyzed: number; healable: number; regressions: number; flaky: number; skipped: number };
}

const SYSTEM = `You are IntelliQE's semantic self-healing agent for API tests. For ONE failing test you are given the test's intent (what it asserts), what it expected, and what the live endpoint ACTUALLY returns now. Decide, by INTENT:
- "regression": the API is genuinely wrong now (a real defect the test correctly caught). DO NOT rewrite the test — it should keep failing.
- "contract-evolution": the API legitimately changed and the test's purpose still holds under the new contract. Propose the minimal patch so the test asserts the new, correct contract.
- "flaky": a timing/nondeterminism blip, not a stable change.
- "environment": a setup/connectivity problem (unreachable, wrong base URL, missing data).
- "auth": a credential/permission problem.
Only set shouldHeal=true for "contract-evolution" (never for a regression — healing a real bug hides it). Reply ONLY with JSON:
{"classification": <one of the above>, "confidence": "high"|"medium"|"low", "shouldHeal": <bool>, "summary": "<=160 chars", "rationale": "<=320 chars — why, in terms of the test's intent", "patch": {"expectedStatus"?: <int>, "expectedResponse"?: "<new sample body to adopt, <=1200 chars>"}}`;

function toHttpEndpoint(f: HealFailure): HttpEndpoint {
  return {
    method: String(f.method || 'GET').toUpperCase(),
    url: f.url,
    headers: Array.isArray(f.headers) ? f.headers : [],
    auth: f.auth && f.auth.type ? { type: f.auth.type, value: f.auth.value, headerName: f.auth.headerName } : undefined,
    body: typeof f.body === 'string' ? f.body : undefined,
  };
}

async function healOne(f: HealFailure, llm: LlmConfig, allowWrites: boolean): Promise<HealProposal> {
  const method = String(f.method || 'GET').toUpperCase();
  const title = String(f.title || `${method} ${f.url}`).slice(0, 160);
  const base: HealProposal = {
    endpointId: f.endpointId, title, method, url: f.url,
    classification: 'unknown', confidence: 'low', shouldHeal: false,
    summary: '', rationale: '',
  };

  // Re-observe the live endpoint — but never re-fire a state-changing request
  // unless explicitly allowed. For a skipped write, the model reasons from the
  // supplied expected/actual context alone.
  let observed: HealProposal['observed'];
  let liveContext = '';
  if (isWriteMethod(method) && !allowWrites) {
    base.note = `Not re-fired (${method} can change state). Reasoned from the recorded failure only — enable "re-run write requests" to probe live.`;
  } else {
    try {
      const { url, init } = buildRequestInit(toHttpEndpoint(f));
      const r = await fetchFull(url, init, 20_000, 2000);
      observed = { status: r.status, reachable: !r.error, bodySnippet: (r.bodyText || r.error || '').slice(0, 1200) };
      liveContext = r.error
        ? `LIVE PROBE: unreachable — ${r.error}`
        : `LIVE STATUS: ${r.status}\nLIVE BODY: ${(r.bodyText || '').slice(0, 1200)}`;
    } catch (e) {
      observed = { reachable: false, bodySnippet: (e as Error).message };
      liveContext = `LIVE PROBE: failed — ${(e as Error).message}`;
    }
  }

  const prompt = [
    `TEST: ${title}`,
    `REQUEST: ${method} ${f.url}`,
    f.expectedStatus ? `EXPECTED STATUS: ${f.expectedStatus}` : '',
    f.expectedResponse ? `EXPECTED RESPONSE (sample the test asserts against): ${String(f.expectedResponse).slice(0, 1000)}` : '',
    f.error ? `FAILURE / ASSERTION: ${String(f.error).slice(0, 1200)}` : '',
    liveContext,
    'Return the JSON now.',
  ].filter(Boolean).join('\n');

  try {
    const raw = await runLLM(prompt, { system: SYSTEM, llm, maxTokens: 900 });
    const parsed = parseJsonFromResponse<Record<string, any>>(raw) || {};
    const classification = (['regression', 'contract-evolution', 'flaky', 'environment', 'auth'].includes(String(parsed.classification)) ? parsed.classification : 'unknown') as HealClassification;
    const confidence = (['high', 'medium', 'low'].includes(String(parsed.confidence)) ? parsed.confidence : 'low') as HealProposal['confidence'];
    // A regression is never healable, whatever the model says — healing a real bug hides it.
    const shouldHeal = classification === 'contract-evolution' && parsed.shouldHeal === true;
    let patch: HealProposal['patch'];
    if (shouldHeal && parsed.patch && typeof parsed.patch === 'object') {
      const p: HealProposal['patch'] = {};
      if (Number.isInteger(Number(parsed.patch.expectedStatus))) p.expectedStatus = Number(parsed.patch.expectedStatus);
      if (typeof parsed.patch.expectedResponse === 'string') p.expectedResponse = parsed.patch.expectedResponse.slice(0, 1200);
      if (p.expectedStatus !== undefined || p.expectedResponse !== undefined) patch = p;
    }
    return {
      ...base,
      classification, confidence, shouldHeal: shouldHeal && !!patch,
      summary: String(parsed.summary || '').slice(0, 160) || classification,
      rationale: String(parsed.rationale || '').slice(0, 320),
      observed, patch,
    };
  } catch (e) {
    return { ...base, summary: 'Could not analyze this failure', rationale: (e as Error).message.slice(0, 320), observed };
  }
}

export async function proposeHeal(failures: HealFailure[], llm: LlmConfig, opts: { allowWrites?: boolean } = {}): Promise<HealResult> {
  if (!llm) throw new Error('Semantic healing needs an LLM — configure one under System Configuration → LLM, or an API-automation LLM provider.');
  const list = (Array.isArray(failures) ? failures : []).filter((f) => f && /^https?:\/\//i.test(String(f.url || ''))).slice(0, 20);
  if (!list.length) throw new Error('No failing requests with an absolute http(s) URL to heal.');

  // Bounded concurrency — healing probes live endpoints; keep it gentle.
  const proposals: HealProposal[] = [];
  const CONC = 4;
  for (let i = 0; i < list.length; i += CONC) {
    const batch = await Promise.all(list.slice(i, i + CONC).map((f) => healOne(f, llm, !!opts.allowWrites)));
    proposals.push(...batch);
  }

  return {
    proposals,
    summary: {
      analyzed: proposals.length,
      healable: proposals.filter((p) => p.shouldHeal).length,
      regressions: proposals.filter((p) => p.classification === 'regression').length,
      flaky: proposals.filter((p) => p.classification === 'flaky').length,
      skipped: proposals.filter((p) => p.note).length,
    },
  };
}
