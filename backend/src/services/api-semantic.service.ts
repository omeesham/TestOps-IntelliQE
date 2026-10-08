/**
 * api-semantic.service.ts
 * ───────────────────────
 * Semantic / AI-response assertions — a standalone, opt-in tool. For endpoints
 * whose response is non-deterministic or AI-generated (an LLM reply, a summary,
 * a recommendation, a chatbot turn), an exact/structural assertion is the wrong
 * tool. This calls the endpoint live and asks the tenant's model to JUDGE the
 * response against a plain-English intent, returning pass/fail + a rationale.
 *
 * Opt-in and standalone — it live-probes the API and never touches the
 * generation/execute/heal pipeline. (testRigor's "test AI-native features".)
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';
import { buildRequestInit, fetchFull, type HttpEndpoint } from '../utils/api-http.js';

export interface SemanticAssertResult {
  intent: string;
  passed: boolean;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  observed: { ok: boolean; status?: number; elapsedMs: number; bodyPreview: string; error?: string };
}

export async function runSemanticAssertion(endpoint: HttpEndpoint, intent: string, llm: LlmConfig): Promise<SemanticAssertResult> {
  const cleanIntent = String(intent || '').trim().slice(0, 1000);
  const { url, init } = buildRequestInit(endpoint);
  const res = await fetchFull(url, init, 25_000, 12_000);

  if (res.error) {
    return {
      intent: cleanIntent, passed: false, confidence: 'high',
      rationale: `The request did not complete, so the intent could not be satisfied: ${res.error}`,
      observed: { ok: false, elapsedMs: res.elapsedMs, bodyPreview: '', error: res.error },
    };
  }

  const prompt = `You are judging whether an API response satisfies a stated intent. The response may be non-deterministic or AI-generated, so judge by MEANING, not exact text. Respond with STRICT JSON only:
{"passed": true|false, "confidence": "high"|"medium"|"low", "rationale": "<=300 chars explaining the verdict, citing what in the response did or didn't satisfy the intent"}

INTENT (what the response should satisfy):
${cleanIntent}

ACTUAL RESPONSE:
HTTP status: ${res.status ?? 'unknown'}
Body:
${res.bodyText.slice(0, 8000) || '(empty body)'}

Judge now. No markdown, no prose outside the JSON.`;

  let parsed: Record<string, unknown> = {};
  try {
    const out = await runLLM(prompt, { maxTokens: 400, llm });
    parsed = parseJsonFromResponse<Record<string, unknown>>(out) || {};
  } catch (err) {
    return {
      intent: cleanIntent, passed: false, confidence: 'low',
      rationale: `Could not evaluate the response with the model: ${(err as Error).message}`,
      observed: { ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, bodyPreview: res.bodyText.slice(0, 400) },
    };
  }

  const confidence = parsed.confidence === 'high' || parsed.confidence === 'low' ? parsed.confidence : 'medium';
  return {
    intent: cleanIntent,
    passed: parsed.passed === true,
    confidence,
    rationale: String(parsed.rationale || '').slice(0, 300) || 'No rationale returned.',
    observed: { ok: res.ok, status: res.status, elapsedMs: res.elapsedMs, bodyPreview: res.bodyText.slice(0, 400) },
  };
}
