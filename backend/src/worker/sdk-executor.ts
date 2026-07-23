/**
 * SDK Executor — calls Anthropic Messages API directly.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  // Keep in sync with the inline pipeline's default (claude-runner.ts
  // DEFAULT_API_MODEL) so both paths run the same Opus tier.
  opus: 'claude-opus-4-8',
};

export interface SdkExecutionResult {
  success: boolean;
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

const COST_PER_M_INPUT: Record<string, number> = { haiku: 0.25, sonnet: 3, opus: 15 };
const COST_PER_M_OUTPUT: Record<string, number> = { haiku: 1.25, sonnet: 15, opus: 75 };

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const inputRate = COST_PER_M_INPUT[model] ?? COST_PER_M_INPUT['sonnet']!;
  const outputRate = COST_PER_M_OUTPUT[model] ?? COST_PER_M_OUTPUT['sonnet']!;
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

export async function callAnthropicAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 4096,
  timeoutMs = 120000,
): Promise<SdkExecutionResult> {
  const modelId = MODEL_MAP[model] ?? model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as any;
      const errMsg = errBody?.error?.message || `HTTP ${res.status}`;
      return { success: false, output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, error: res.status === 429 ? `rate_limit: ${errMsg}` : errMsg };
    }

    const data = await res.json() as any;
    const textBlocks = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text);
    const output = textBlocks.join('\n');
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return { success: true, output, inputTokens, outputTokens, costUsd: computeCost(model, inputTokens, outputTokens) };
  } catch (err: any) {
    clearTimeout(timer);
    return { success: false, output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, error: err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : err.message };
  }
}
