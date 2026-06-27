/**
 * SDK Executor — calls Anthropic Messages API directly.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
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

type ModelFamily = 'haiku' | 'sonnet' | 'opus';

const COST_PER_M_INPUT: Record<ModelFamily, number> = { haiku: 0.25, sonnet: 3, opus: 15 };
const COST_PER_M_OUTPUT: Record<ModelFamily, number> = { haiku: 1.25, sonnet: 15, opus: 75 };

/**
 * Derive the pricing family from either a short alias ('opus') or a fully
 * resolved model id ('claude-opus-4-8'). Pricing is keyed by family, so the
 * lookup must work off the resolved id too — otherwise per-version ids skip the
 * rate table, fall back to the sonnet default, and skew the budget caps.
 */
function modelFamily(model: string): ModelFamily {
  const id = model.toLowerCase();
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('opus')) return 'opus';
  return 'sonnet';
}

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const family = modelFamily(model);
  return (inputTokens * COST_PER_M_INPUT[family] + outputTokens * COST_PER_M_OUTPUT[family]) / 1_000_000;
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
    return { success: true, output, inputTokens, outputTokens, costUsd: computeCost(modelId, inputTokens, outputTokens) };
  } catch (err: any) {
    clearTimeout(timer);
    return { success: false, output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, error: err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : err.message };
  }
}
