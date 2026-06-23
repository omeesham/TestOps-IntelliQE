import type { TestOpsState } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';

export function auditAgent(state: TestOpsState): TestOpsState {
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

  const response = runClaudePrompt(prompt, { maxTokens: 2048 });
  const parsed = parseJsonFromResponse<{
    additionalEdgeCases: string[];
    securityConcerns: string[];
    additionalDataRules: string[];
  }>(response);

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
