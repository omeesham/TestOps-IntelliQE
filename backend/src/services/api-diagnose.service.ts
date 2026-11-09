/**
 * api-diagnose.service.ts
 * ───────────────────────
 * AI root-cause triage for one failed API test — a standalone, opt-in helper.
 * It asks the tenant's model to classify the failure and explain it in plain
 * English, and builds a deterministic repro `curl`. It reads nothing and heals
 * nothing; the self-healing pipeline is untouched.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export interface FailureInput {
  title?: string;
  method: string;
  url: string;
  error: string;
  expectedStatus?: number;
  requestBody?: string;
  responseStatus?: number;
  responseBody?: string;
}

export interface Diagnosis {
  category: string;
  /** One-line headline the UI leads with. */
  summary: string;
  /** Deeper plain-English explanation of what actually went wrong and why. */
  rootCause: string;
  /** The specific signals in the request/response/error that point to this cause. */
  evidence: string[];
  /** What this failure means — blast radius, who/what it blocks. */
  impact: string;
  /** Concrete, ordered remediation steps. */
  fixSteps: string[];
  /** One-line summary fix (kept for the bug-report service + compact callers). */
  suggestedFix: string;
  /** How to keep this class of failure from recurring. */
  prevention: string;
  confidence: 'high' | 'medium' | 'low';
  reproCurl: string;
}

const CATEGORIES = ['assertion-drift', 'server-defect', 'auth', 'data-setup', 'contract', 'rate-limited', 'flaky', 'unknown'];

function buildCurl(f: FailureInput): string {
  const method = (f.method || 'GET').toUpperCase();
  const lines = [`curl -i -X ${method} '${f.url}'`];
  if (f.requestBody && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    lines.push(`  -H 'Content-Type: application/json'`);
    lines.push(`  -d '${f.requestBody.replace(/'/g, "'\\''").slice(0, 1000)}'`);
  }
  return lines.join(' \\\n');
}

/** Coerce an unknown LLM value into a clean string[] (accepts a string or an array). */
function toStringList(v: unknown, max = 6, cap = 240): string[] {
  const raw = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(/\r?\n|(?<=\.)\s+(?=[A-Z0-9])/) // split a blob into sentences/lines as a fallback
      : [];
  return raw
    .map((x) => String(x ?? '').replace(/^\s*[-*\d.)\]]+\s*/, '').trim().slice(0, cap))
    .filter(Boolean)
    .slice(0, max);
}

export async function diagnoseFailure(f: FailureInput, llm: LlmConfig): Promise<Diagnosis> {
  const prompt = `You are a senior SDET triaging ONE failed API test. Be thorough and specific — cite the actual status codes, fields, and error text you were given rather than speaking in generalities. Respond with STRICT JSON only:
{
  "category": one of ${JSON.stringify(CATEGORIES)},
  "summary": "<=120 chars, a one-line headline of what went wrong",
  "rootCause": "<=600 chars, a detailed plain-English explanation of WHAT went wrong and WHY, referencing the specific request/response/error signals",
  "evidence": ["2-4 short bullet strings, each a concrete observed signal that supports the root cause (e.g. 'Actual status 404 vs expected 200', 'Response body: {\\"message\\":\\"Pet not found\\"}')"],
  "impact": "<=200 chars, what this failure blocks or means for the suite/users",
  "fixSteps": ["2-5 short, ordered, concrete remediation steps — imperative, actionable"],
  "suggestedFix": "<=200 chars, the single most important next action (a condensed version of step 1)",
  "prevention": "<=200 chars, how to keep this class of failure from recurring",
  "confidence": "high" | "medium" | "low"
}

Guidance on category: "assertion-drift" = the test asserted something the API never promised; "server-defect" = a real 5xx bug; "auth" = credential/permission problem; "data-setup" = missing precondition data; "contract" = response shape diverged from the spec; "rate-limited" = 429/throttling; "flaky" = timing/nondeterminism. No markdown, no prose outside the JSON.

FAILED TEST: ${(f.title || '').slice(0, 160)}
REQUEST: ${(f.method || 'GET').toUpperCase()} ${f.url}
${f.expectedStatus ? `EXPECTED STATUS: ${f.expectedStatus}` : ''}
${f.responseStatus ? `ACTUAL STATUS: ${f.responseStatus}` : ''}
${f.requestBody ? `REQUEST BODY: ${f.requestBody.slice(0, 800)}` : ''}
ERROR: ${(f.error || '').slice(0, 1500)}
${f.responseBody ? `RESPONSE BODY: ${f.responseBody.slice(0, 800)}` : ''}

Return the JSON now.`;

  const res = await runLLM(prompt, { maxTokens: 1200, llm });
  let parsed: Record<string, unknown> = {};
  try { parsed = (parseJsonFromResponse<Record<string, unknown>>(res)) || {}; } catch { /* fall back below */ }

  const category = typeof parsed.category === 'string' && CATEGORIES.includes(parsed.category) ? parsed.category : 'unknown';
  const confidence = parsed.confidence === 'high' || parsed.confidence === 'low' ? parsed.confidence : 'medium';
  const rootCause = String(parsed.rootCause || res.slice(0, 600) || 'Could not determine a root cause.').slice(0, 600);
  const fixSteps = toStringList(parsed.fixSteps, 5, 240);
  const suggestedFix = String(parsed.suggestedFix || fixSteps[0] || '').slice(0, 240);

  return {
    category,
    summary: String(parsed.summary || rootCause).slice(0, 120),
    rootCause,
    evidence: toStringList(parsed.evidence, 4, 240),
    impact: String(parsed.impact || '').slice(0, 240),
    fixSteps,
    suggestedFix,
    prevention: String(parsed.prevention || '').slice(0, 240),
    confidence,
    reproCurl: buildCurl(f),
  };
}
