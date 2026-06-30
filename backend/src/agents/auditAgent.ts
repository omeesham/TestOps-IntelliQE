import type { TestOpsState } from './state.js';
import { runLLM, parseJsonFromResponse, llmForStage } from './claude-runner.js';

export async function auditAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.parsedRequirements) return state;

  const { features, flows, edgeCases } = state.parsedRequirements;

  const prompt = `You are a QA edge-case auditor. Given these features and flows, identify ONLY genuinely high-value, in-scope edge cases or concerns that a tester would actually run for THIS functionality — and that aren't already covered.

Features: ${features.join(', ')}
Flows: ${flows.join(', ')}
Existing edge cases: ${edgeCases.join(', ')}
Requirements: ${state.requirements}

Return ONLY valid JSON (no markdown):
{
  "additionalEdgeCases": ["case 1", "case 2", ...],
  "securityConcerns": ["concern 1", "concern 2", ...],
  "additionalDataRules": ["rule 1", "rule 2", ...]
}

STRICT RELEVANCE RULES:
- Add ONLY items that genuinely apply to the features above. Do NOT add a generic battery.
- Include a security concern (XSS, SQL injection, CSRF, brute-force, etc.) ONLY if the feature actually processes untrusted input in a way that makes it materially relevant AND it isn't already covered. For a basic login form, at most note credential-handling basics — do not enumerate every attack class.
- Do NOT add concurrency, network-failure, accessibility, or performance items unless the functionality clearly involves them.
- Quality over quantity: a few sharp, relevant items — or EMPTY arrays — is the correct answer when nothing material is missing. Do not pad.`;

  let parsed: { additionalEdgeCases?: string[]; securityConcerns?: string[]; additionalDataRules?: string[] };
  try {
    const response = await runLLM(prompt, { maxTokens: 6000, llm: llmForStage(state.llm, 'audit') });
    parsed = parseJsonFromResponse(response);
  } catch (err) {
    // Audit is an enhancement pass — never let it abort the pipeline.
    console.warn('[auditAgent] skipped (LLM/parse failed):', (err as Error).message);
    return state;
  }

  const allEdgeCases = [
    ...edgeCases,
    ...(parsed.additionalEdgeCases || []),
    ...(parsed.securityConcerns || []),
  ];
  const allDataRules = [
    ...state.parsedRequirements.dataRules,
    ...(parsed.additionalDataRules || []),
  ];

  return {
    ...state,
    parsedRequirements: { ...state.parsedRequirements, edgeCases: allEdgeCases, dataRules: allDataRules },
  };
}
