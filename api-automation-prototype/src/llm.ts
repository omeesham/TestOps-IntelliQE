/**
 * llm.ts — the single Anthropic Messages API call.
 *
 * One request per generate. The model returns TEXT (a JSON array as a string);
 * generator.ts parses it into typed data. The model never produces code, and
 * nothing it returns is ever executed as code — it is parsed as JSON.
 *
 * Model default: claude-opus-5-5 (the current Opus and the default model).
 * Override with the MODEL env var.
 */
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.MODEL || 'claude-opus-5-5';

/** True when a credential is available (env key). */
export function hasCredentials(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic(); // resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant profile
  return client;
}

/**
 * Send one prompt, return the concatenated text of the response.
 * Opus 5.5 runs adaptive thinking by default; we only need the text blocks.
 */
export async function callModel(prompt: string): Promise<string> {
  if (!hasCredentials()) {
    throw new Error(
      'No model credentials: set ANTHROPIC_API_KEY (copy .env.example to .env). ' +
        'The generator needs the Anthropic API to design test cases.',
    );
  }
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
