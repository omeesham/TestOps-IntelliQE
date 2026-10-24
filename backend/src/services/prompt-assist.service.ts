/**
 * prompt-assist.service
 * ─────────────────────
 * Prompt suggestions in Chat: the user writes what to test in plain language
 * and gets up to 3 sharper versions to pick from (focused, broader coverage,
 * risk-focused). The chosen text then drives test generation as before.
 *
 * Grounding: suggestions only reword and structure the user's intent with
 * test-design language; they must not add features, pages, fields or rules.
 * Only the application name and environment are sent as context, never URLs
 * or credentials.
 */
import { runClaudePrompt, parseJsonFromResponse } from '../agents/claude-runner.js';

export interface PromptSuggestion {
  /** Short label: "Focused", "Broader coverage", "Risk-focused". */
  title: string;
  /** One line on what this version emphasises. */
  why: string;
  /** The improved prompt, ready to use. */
  prompt: string;
}

export interface PromptAssistContext {
  appName?: string;
  environment?: string;
}

export const MAX_PROMPT_CHARS = 2000;

/**
 * A fast, low-cost model for this short call. PROMPT_ASSIST_MODEL overrides it;
 * if the model is not available the default model is used instead.
 */
const FAST_MODEL = process.env.PROMPT_ASSIST_MODEL || (process.env.ANTHROPIC_API_KEY ? 'claude-haiku-4-5' : 'haiku');

export function buildAssistPrompt(input: string, ctx: PromptAssistContext): string {
  const facts = [
    ctx.appName && `Application: ${ctx.appName.slice(0, 80)}`,
    ctx.environment && `Environment: ${ctx.environment.slice(0, 40)}`,
  ].filter(Boolean).join('\n');

  return `A tester wants AI to generate test cases. They wrote this requirement in plain language:
"""
${input.slice(0, MAX_PROMPT_CHARS)}
"""
${facts ? `\nKnown facts:\n${facts}\n` : ''}
Write exactly 3 improved versions of their text. Each must keep their intent, be clear and specific, and name the test-design focus that fits it (happy paths, invalid inputs, boundary values, business rules, error handling, roles).

1. "Focused": the same scope, made precise and testable.
2. "Broader coverage": the same feature area, adding the negative, boundary and edge cases a senior tester would expect.
3. "Risk-focused": prioritise what would hurt the business most if it broke, and the riskiest inputs.

Rules:
- Do NOT add features, screens, fields, limits or rules the tester did not mention. Refer to them generally ("the form", "each field's limits") when unsure.
- Plain language a tester would write. Each version at most ${MAX_PROMPT_CHARS} characters. No markdown.

Return ONLY JSON:
{"suggestions":[{"title":"Focused","why":"one short line","prompt":"..."},{"title":"Broader coverage","why":"...","prompt":"..."},{"title":"Risk-focused","why":"...","prompt":"..."}]}`;
}

/** Keep well-formed suggestions only, with bounded lengths. */
export function cleanSuggestions(raw: unknown): PromptSuggestion[] {
  const obj = raw as { suggestions?: unknown } | unknown[] | null;
  const list: unknown[] = Array.isArray(obj) ? obj : Array.isArray((obj as { suggestions?: unknown })?.suggestions) ? (obj as { suggestions: unknown[] }).suggestions : [];
  return list
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).prompt === 'string' && !!String((s as Record<string, unknown>).prompt).trim())
    .slice(0, 3)
    .map((s) => ({
      title: String(s.title || 'Suggestion').slice(0, 40),
      why: String(s.why || '').slice(0, 160),
      prompt: String(s.prompt).trim().slice(0, MAX_PROMPT_CHARS),
    }));
}

export async function suggestPrompts(input: string, ctx: PromptAssistContext): Promise<PromptSuggestion[]> {
  const prompt = buildAssistPrompt(input, ctx);
  let response: string;
  try {
    response = await runClaudePrompt(prompt, { maxTokens: 1500, model: FAST_MODEL });
  } catch (err) {
    console.warn(`[prompt-assist] ${FAST_MODEL} failed (${(err as Error).message}); retrying with the default model`);
    response = await runClaudePrompt(prompt, { maxTokens: 1500 });
  }
  return cleanSuggestions(parseJsonFromResponse<unknown>(response));
}

/**
 * Per-user rate limit for suggestion calls (each is an AI call). Entries for
 * users with no recent calls are removed, so the map does not grow forever.
 */
export class AssistRateLimit {
  private calls = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 60_000) {}

  /** Records a call and returns true when allowed; false when over the limit. */
  allow(user: string, now = Date.now()): boolean {
    for (const [u, times] of this.calls) {
      const recent = times.filter((t) => now - t < this.windowMs);
      if (recent.length) this.calls.set(u, recent); else this.calls.delete(u);
    }
    const recent = this.calls.get(user) || [];
    if (recent.length >= this.max) return false;
    this.calls.set(user, [...recent, now]);
    return true;
  }

  get size(): number { return this.calls.size; }
}
