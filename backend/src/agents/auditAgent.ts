import type { TestOpsState } from './state.js';
import { runClaudeJson } from './claude-runner.js';

export async function auditAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.parsedRequirements) return state;

  const { features, flows, edgeCases } = state.parsedRequirements;

  const prompt = `You are a QA security and edge-case auditor. Given these features and flows, identify additional edge cases, security concerns, and boundary conditions that should be tested.

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

Focus on: XSS, SQL injection, CSRF, session management, input validation, boundary values, concurrent access, error recovery, accessibility.`;

  // The audit only ENRICHES the requirements with extra edge/security cases — it
  // is not on the critical path. If Claude returns unparseable/truncated JSON,
  // degrade gracefully and proceed with the un-enriched requirements rather than
  // failing the whole generation (this used to crash the pipeline intermittently).
  let parsed: {
    additionalEdgeCases?: string[];
    securityConcerns?: string[];
    additionalDataRules?: string[];
  };
  try {
    parsed = await runClaudeJson(prompt, { maxTokens: 4096, model: 'claude-sonnet-4-6', attempts: 2 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[auditAgent] enrichment failed, proceeding without extra cases:', (err as Error).message);
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
