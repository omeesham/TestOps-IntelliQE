/**
 * provider-runner.ts
 * ──────────────────
 * Multi-LLM provider adapter. IntelliQE's default path is Anthropic (see
 * claude-runner.ts) and is COMPLETELY UNCHANGED. This module is reached ONLY
 * when an admin has explicitly configured a non-Anthropic provider (llm.provider
 * set to something other than 'anthropic'); with nothing configured, none of
 * this code runs and generation behaves exactly as before.
 *
 * Supported providers (compliance / cost driver for enterprises):
 *   - 'openai'            → OpenAI Chat Completions (api.openai.com/v1)
 *   - 'openai-compatible' → any OpenAI-compatible server (OpenRouter, Together,
 *                           Groq, vLLM, Ollama, LM Studio) via a custom baseUrl
 *   - 'azure-openai'      → Azure OpenAI (baseUrl is the full deployment URL)
 *   - 'gemini'            → Google Gemini (generativelanguage.googleapis.com)
 *
 * Returns the response text, mirroring runLLM's contract. Streaming is not used
 * here — these calls are bounded and the adapter keeps a generous timeout.
 */

export type LlmProvider = 'anthropic' | 'openai' | 'openai-compatible' | 'azure-openai' | 'gemini';

export interface ProviderCallOpts {
  provider: LlmProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxTokens: number;
  system?: string;
}

const PROVIDER_DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  'azure-openai': '',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/** Normalise a provider string to a known value (default 'openai-compatible'). */
export function normalizeProvider(p: unknown): LlmProvider {
  const s = String(p || '').toLowerCase();
  if (s === 'anthropic') return 'anthropic';
  if (s === 'openai') return 'openai';
  if (s === 'azure-openai' || s === 'azure') return 'azure-openai';
  if (s === 'gemini' || s === 'google') return 'gemini';
  return 'openai-compatible';
}

export function isNonAnthropicProvider(p: unknown): boolean {
  return !!p && normalizeProvider(p) !== 'anthropic';
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms = 600_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fn(controller.signal); }
  finally { clearTimeout(timer); }
}

/** OpenAI-style Chat Completions (covers OpenAI, Azure OpenAI, and all compatible servers). */
async function runOpenAICompatible(prompt: string, opts: ProviderCallOpts): Promise<string> {
  const isAzure = opts.provider === 'azure-openai';
  const base = (opts.baseUrl || PROVIDER_DEFAULT_BASE[opts.provider] || PROVIDER_DEFAULT_BASE['openai-compatible']).replace(/\/+$/, '');
  // Azure uses the full deployment URL as baseUrl and an api-key header; the
  // others use {base}/chat/completions with a Bearer key.
  const url = isAzure
    ? (/\/chat\/completions/i.test(base) ? base : `${base}/chat/completions?api-version=2024-10-21`)
    : `${base}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (isAzure) headers['api-key'] = opts.apiKey || '';
  else headers['authorization'] = `Bearer ${opts.apiKey || ''}`;

  const messages: { role: string; content: string }[] = [];
  if (opts.system && opts.system.trim()) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens, messages }),
      signal,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as any;
      const msg = errBody?.error?.message || errBody?.message || `HTTP ${res.status}`;
      throw new Error(`${opts.provider} error (${res.status}): ${msg}`);
    }
    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content;
    const out = (typeof text === 'string' ? text : Array.isArray(text) ? text.map((t: any) => t?.text || '').join('') : '').trim();
    if (!out) throw new Error(`${opts.provider} returned no text content`);
    return out;
  });
}

/** Google Gemini generateContent. */
async function runGemini(prompt: string, opts: ProviderCallOpts): Promise<string> {
  const base = (opts.baseUrl || PROVIDER_DEFAULT_BASE['gemini']).replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey || '')}`;
  const body: any = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: opts.maxTokens },
  };
  if (opts.system && opts.system.trim()) body.systemInstruction = { parts: [{ text: opts.system }] };

  return withTimeout(async (signal) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as any;
      const msg = errBody?.error?.message || `HTTP ${res.status}`;
      throw new Error(`gemini error (${res.status}): ${msg}`);
    }
    const data = (await res.json()) as any;
    const parts = data?.candidates?.[0]?.content?.parts;
    const out = (Array.isArray(parts) ? parts.map((p: any) => p?.text || '').join('') : '').trim();
    if (!out) throw new Error('gemini returned no text content');
    return out;
  });
}

/** Dispatch to the right provider. Never called for 'anthropic'. */
export async function runViaProvider(prompt: string, opts: ProviderCallOpts): Promise<string> {
  const provider = normalizeProvider(opts.provider);
  if (provider === 'gemini') return runGemini(prompt, { ...opts, provider });
  return runOpenAICompatible(prompt, { ...opts, provider });
}
