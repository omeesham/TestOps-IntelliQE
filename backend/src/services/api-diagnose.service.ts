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
  rootCause: string;
  suggestedFix: string;
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

export async function diagnoseFailure(f: FailureInput, llm: LlmConfig): Promise<Diagnosis> {
  const prompt = `You are a senior SDET triaging ONE failed API test. From the request and the failure, respond with STRICT JSON only:
{"category": one of ${JSON.stringify(CATEGORIES)}, "rootCause": "<=280 chars, plain English — what actually went wrong", "suggestedFix": "<=280 chars, concrete next action", "confidence": "high" | "medium" | "low"}

Guidance: "assertion-drift" = the test asserted something the API never promised; "server-defect" = a real 5xx bug; "auth" = credential/permission problem; "data-setup" = missing precondition data; "contract" = response shape diverged from the spec; "rate-limited" = 429/throttling; "flaky" = timing/nondeterminism. No markdown, no prose outside the JSON.

FAILED TEST: ${(f.title || '').slice(0, 160)}
REQUEST: ${(f.method || 'GET').toUpperCase()} ${f.url}
${f.expectedStatus ? `EXPECTED STATUS: ${f.expectedStatus}` : ''}
${f.responseStatus ? `ACTUAL STATUS: ${f.responseStatus}` : ''}
${f.requestBody ? `REQUEST BODY: ${f.requestBody.slice(0, 800)}` : ''}
ERROR: ${(f.error || '').slice(0, 1500)}
${f.responseBody ? `RESPONSE BODY: ${f.responseBody.slice(0, 800)}` : ''}

Return the JSON now.`;

  const res = await runLLM(prompt, { maxTokens: 500, llm });
  let parsed: Record<string, unknown> = {};
  try { parsed = (parseJsonFromResponse<Record<string, unknown>>(res)) || {}; } catch { /* fall back below */ }

  const category = typeof parsed.category === 'string' && CATEGORIES.includes(parsed.category) ? parsed.category : 'unknown';
  const confidence = parsed.confidence === 'high' || parsed.confidence === 'low' ? parsed.confidence : 'medium';
  return {
    category,
    rootCause: String(parsed.rootCause || res.slice(0, 280) || 'Could not determine a root cause.'),
    suggestedFix: String(parsed.suggestedFix || ''),
    confidence,
    reproCurl: buildCurl(f),
  };
}
