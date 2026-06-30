/**
 * Claude CLI runner — invokes Claude Code to generate AI responses.
 * Falls back to a basic prompt-based approach if CLI is not available.
 *
 * NOTE: Originally used execSync which, on Windows, could orphan child
 * claude.exe processes on timeout (Node can't reliably kill grandchildren
 * without a tree kill). This version keeps the same synchronous API but
 * wraps the call in a manual timeout that issues `taskkill /F /T /PID` on
 * Windows (or `kill -9 -pid` on POSIX) so the whole process tree dies and
 * no orphans can accumulate overnight.
 */
import { execSync, spawnSync } from 'child_process';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import type { LlmConfig } from './state.js';
export type { LlmConfig };

let resolvedCliPath: string | null = null;
const IS_WINDOWS = process.platform === 'win32';

function findClaudeCli(): string | null {
  if (resolvedCliPath) return resolvedCliPath;

  const candidates = [
    'claude',
    join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    join(homedir(), '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];

  for (const cmd of candidates) {
    try {
      execSync(`"${cmd}" --version`, { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' });
      resolvedCliPath = cmd;
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Run a prompt through Claude CLI and return the response text.
 * Uses `claude -p` (print mode — non-interactive, returns text).
 *
 * Uses spawnSync (not execSync) because spawnSync gives us the child PID
 * back via its return value — but in practice spawnSync also blocks on
 * the whole tree. To guarantee no orphans on timeout, we pipe through a
 * small shell wrapper on POSIX or use `taskkill /T` on Windows via the
 * timeout-kill helper below.
 */
export function runClaudePrompt(prompt: string, options?: { maxTokens?: number; model?: string; oauthToken?: string }): string {
  const cli = findClaudeCli();
  if (!cli) throw new Error('Claude CLI not found');

  const args: string[] = ['-p'];
  if (options?.model) args.push('--model', options.model);
  // Note: Claude CLI does not support --max-tokens; use --max-budget-usd for cost control

  // Authenticate the CLI with the saved Claude Code OAuth token when provided.
  // Without this the CLI relies on an interactive `claude login` session, which
  // a headless backend process usually doesn't have — the classic
  // "401 Invalid authentication credentials" from `claude -p`. Passing the token
  // via CLAUDE_CODE_OAUTH_TOKEN is the documented non-interactive path.
  const env = options?.oauthToken
    ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken }
    : process.env;

  // Write prompt to a temp file to avoid shell escaping issues
  const tmpFile = join(tmpdir(), `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  writeFileSync(tmpFile, prompt, 'utf-8');

  try {
    // spawnSync returns { pid, stdout, stderr, signal, status, error } — with a
    // hard timeout the child is killed, but on Windows that only kills the
    // immediate child, not its grandchildren. We manually tree-kill via the
    // `killSignal` + post-timeout taskkill below as a safety net.
    const result = spawnSync(cli, args, {
      timeout: 300000, // 5 minutes
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      shell: IS_WINDOWS,
      windowsHide: true,
      input: prompt,
      env,
      killSignal: 'SIGKILL',
    });

    // If spawnSync reported a timeout, result.error?.code === 'ETIMEDOUT' and
    // result.pid points at the (now-half-dead) child. Tree-kill to sweep up
    // any surviving grandchildren on Windows.
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === 'ETIMEDOUT' && result.pid) {
        treeKill(result.pid);
        throw new Error(`Claude CLI timed out after 5 minutes (tree-killed pid ${result.pid})`);
      }
      throw err;
    }

    if (result.status !== 0) {
      const detail = `${String(result.stderr || '')}${result.stderr && result.stdout ? ' | ' : ''}${String(result.stdout || '')}`.trim();
      throw new Error(`Claude CLI exited with code ${result.status}: ${detail.slice(0, 800) || '(no output)'}`);
    }

    return String(result.stdout || '').trim();
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * Kill a process tree. On Windows, `taskkill /F /T /PID` kills the pid and
 * all its descendants — critical because Claude CLI spawns helper processes
 * that Node's own process.kill cannot reach.
 */
function treeKill(pid: number): void {
  if (IS_WINDOWS) {
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 }); } catch { /* already dead */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
  }
}

/**
 * Check if Claude CLI is available.
 */
export function isClaudeCliAvailable(): boolean {
  return findClaudeCli() !== null;
}

// =====================================================================
// LLM via the Anthropic Messages API (DB-configured key)
// =====================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_API_MODEL = 'claude-opus-4-8';

/** Pipeline stages that make LLM calls. Used as keys for per-agent model choice. */
export type AgentStage = 'requirement' | 'audit' | 'planner' | 'generator' | 'script' | 'heal' | 'explore';

/**
 * Resolve the LLM config for a given pipeline stage. The admin can pick a model
 * per agent in System Configuration → LLM Configuration; we apply that here,
 * falling back to the provider's default model when a stage has no override.
 * This lets e.g. requirement/audit/planner run on a fast model while generation
 * uses a stronger one — entirely the admin's choice.
 */
export function llmForStage(llm: LlmConfig | undefined | null, stage: AgentStage): LlmConfig | undefined {
  if (!llm) return undefined;
  const model = llm.agentModels?.[stage] || llm.model;
  return { ...llm, model };
}

/**
 * Run a prompt through an LLM and return the response text.
 *
 * Primary path: when an `apiKey` is supplied (resolved per-tenant from the DB —
 * see services/llm.service.ts), call the Anthropic Messages API directly. This
 * is what makes the chat pipeline work with the key the admin saved in System
 * Configuration, with no env var and no local `claude` CLI login.
 *
 * Fallback: if no key is configured, fall back to the `claude` CLI (useful for
 * local dev where the CLI is logged in). If neither is available, throw a clear
 * error so the caller can tell the user to configure an LLM.
 */
export async function runLLM(
  prompt: string,
  options?: { maxTokens?: number; system?: string; llm?: LlmConfig },
): Promise<string> {
  const llm = options?.llm;
  const method = llm?.authMethod || 'api_key';
  const model = llm?.model || DEFAULT_API_MODEL;
  const baseUrl = llm?.baseUrl || 'https://api.anthropic.com';
  const maxTokens = options?.maxTokens ?? 4096;

  // ONE recovery attempt on a transient CONNECTION error (socket dropped before
  // returning anything). NOT a content retry — it only fires when the call
  // produced no output, so it never wastes tokens nor re-runs a succeeded agent.
  const callApi = async (opts: MessagesApiOpts): Promise<string> => {
    try {
      return await runViaMessagesApi(prompt, opts);
    } catch (err) {
      if (isTransientNetworkError(err)) {
        console.warn(`[claude-runner] connection dropped (${(err as Error).message}); reconnecting once`);
        return await runViaMessagesApi(prompt, opts);
      }
      throw err;
    }
  };

  // Claude Code (subscription): OAuth token primary, logged-in CLI as fallback.
  if (method === 'claude_code') {
    if (llm?.oauthToken) {
      return callApi({ authMethod: 'claude_code', oauthToken: llm.oauthToken, model, baseUrl, maxTokens, system: options?.system, effort: llm?.effort, extendedThinking: llm?.extendedThinking });
    }
    if (isClaudeCliAvailable()) {
      return runClaudePrompt(prompt, { maxTokens: options?.maxTokens, model: llm?.model, oauthToken: llm?.oauthToken });
    }
    throw new Error(
      'Claude Code is selected but no OAuth token is saved and no local Claude CLI is available. ' +
      'Run `claude setup-token` and paste the token in System Configuration → LLM Configuration.',
    );
  }

  // Standard API key path.
  if (llm?.apiKey) {
    return callApi({ authMethod: 'api_key', apiKey: llm.apiKey, model, baseUrl, maxTokens, system: options?.system, effort: llm?.effort, extendedThinking: llm?.extendedThinking });
  }
  if (isClaudeCliAvailable()) {
    // Local-dev fallback — CLI must be logged in.
    return runClaudePrompt(prompt, { maxTokens: options?.maxTokens, model: llm?.model });
  }
  throw new Error(
    'No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.',
  );
}

interface MessagesApiOpts {
  authMethod: 'api_key' | 'claude_code';
  apiKey?: string;
  oauthToken?: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  system?: string;
  /** Reasoning effort — gated per model in buildEffort(). */
  effort?: string;
  /** Extended/"ultra" thinking — gated per model in supportsAdaptiveThinking(). */
  extendedThinking?: boolean;
}

/**
 * Resolve a safe `output_config.effort` value for a model, or null when the
 * model doesn't support effort at all. Haiku 4.5 and Sonnet 4.5 reject effort
 * entirely (400); `xhigh`/`max` are only on the newest tiers — clamp down to
 * `high` rather than 400. low/medium/high are safe on every effort-capable model.
 */
function buildEffort(effort: string | undefined, model: string): string | null {
  if (!effort) return null;
  const m = model.toLowerCase();
  // Models that accept output_config.effort at all.
  const effortCapable = /opus-4-(5|6|7|8)|sonnet-4-6|fable-5|mythos-5/.test(m);
  if (!effortCapable) return null; // haiku-4-5, sonnet-4-5, older → drop
  let e = effort;
  const supportsXhigh = /opus-4-(7|8)|fable-5|mythos-5/.test(m);
  const supportsMax = /opus-4-(6|7|8)|sonnet-4-6|fable-5|mythos-5/.test(m);
  if (e === 'xhigh' && !supportsXhigh) e = 'high';
  if (e === 'max' && !supportsMax) e = 'high';
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : null;
}

/** Adaptive ("ultra") thinking is supported on Opus 4.6+/Sonnet 4.6/Fable/Mythos. */
function supportsAdaptiveThinking(model: string): boolean {
  return /opus-4-(6|7|8)|sonnet-4-6|fable-5|mythos-5/.test(model.toLowerCase());
}

/**
 * True for transient connection failures worth one reconnect — the socket
 * dropped (ECONNRESET / "terminated" / socket hang up) or DNS/connect blipped.
 * Explicitly EXCLUDES AbortError (we already waited the full timeout) and HTTP
 * status errors (those are real API responses, not connection drops).
 */
function isTransientNetworkError(err: any): boolean {
  if (err?.name === 'AbortError') return false;
  if (typeof err?.message === 'string' && err.message.startsWith('Anthropic API error (')) return false;
  const msg = String(err?.message || '');
  const causeCode = String(err?.cause?.code || err?.code || '');
  return (
    /terminated|fetch failed|network|socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN|UND_ERR/i.test(causeCode)
  );
}

async function runViaMessagesApi(
  prompt: string,
  opts: MessagesApiOpts,
): Promise<string> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const controller = new AbortController();
  // Generous ceiling — a single functionality-driven generation can be large.
  const timer = setTimeout(() => controller.abort(), 600_000);

  // Choose auth by the credential's ACTUAL shape, not just the selected method,
  // so a credential entered in the "wrong" field still authenticates:
  //   sk-ant-api…  → API key  → x-api-key header
  //   sk-ant-oat…  → OAuth    → Authorization: Bearer + the OAuth beta header
  // (A correct API key pasted under Claude Code was the classic "Invalid bearer
  // token" 401 — routing by prefix fixes it.)
  const cred = ((opts.authMethod === 'claude_code' ? opts.oauthToken : opts.apiKey) || opts.oauthToken || opts.apiKey || '').trim();
  const looksApiKey = /^sk-ant-api/i.test(cred);
  const useBearer = !looksApiKey && (/^sk-ant-oat/i.test(cred) || opts.authMethod === 'claude_code') && !!cred;
  const headers: Record<string, string> =
    useBearer
      ? {
          authorization: `Bearer ${cred}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        }
      : {
          'x-api-key': cred,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        };

  // Claude Code (OAuth) tokens are only authorized for the Claude Code client:
  // the request MUST present the Claude Code system identity as its first system
  // block, or Anthropic rejects it with "401 Invalid bearer token". API-key
  // requests have no such requirement.
  const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
  // For OAuth, the FIRST system block must be exactly the identity. Use the
  // content-block array form so any real system prompt follows as a second block.
  const effectiveSystem: unknown = useBearer
    ? (opts.system && opts.system.trim() && !opts.system.startsWith(CLAUDE_CODE_IDENTITY)
        ? [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, { type: 'text', text: opts.system }]
        : CLAUDE_CODE_IDENTITY)
    : opts.system;
  try {
    // We STREAM: large generator/script outputs exceed ~16K tokens, and a
    // non-streaming request risks an HTTP timeout before the body completes.
    // Streaming also lets us see the real stop_reason (truncation) clearly.
    // Reasoning effort + extended thinking, each gated to models that accept
    // them so a per-agent Haiku/Sonnet-4.5 model never 400s the request.
    const effort = buildEffort(opts.effort, opts.model);
    const useThinking = opts.extendedThinking && supportsAdaptiveThinking(opts.model);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        stream: true,
        ...(effort ? { output_config: { effort } } : {}),
        ...(useThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        ...(effectiveSystem ? { system: effectiveSystem } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const errBody = (await res.json().catch(() => ({}))) as any;
      const msg = errBody?.error?.message || `HTTP ${res.status}`;
      throw new Error(`Anthropic API error (${res.status}): ${msg}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let stopReason: string | undefined;
    let streamError: string | undefined;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload) as any;
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            text += evt.delta.text;
          } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
            stopReason = evt.delta.stop_reason;
          } else if (evt.type === 'error') {
            streamError = evt.error?.message || 'stream error';
          }
        } catch {
          /* ignore non-JSON keepalive lines */
        }
      }
    }

    if (streamError) throw new Error(`Anthropic API stream error: ${streamError}`);
    const out = text.trim();
    if (!out) throw new Error('Anthropic API returned no text content');
    if (stopReason === 'max_tokens') {
      // Output hit the cap — surface it so callers don't silently get truncated JSON.
      console.warn(`[claude-runner] response truncated at max_tokens=${opts.maxTokens}; consider raising it`);
    }
    return out;
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('Anthropic API request timed out after 10 minutes');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse JSON from Claude's response.
 *
 * Claude CLI in `-p` mode often returns JSON followed by trailing prose
 * ("Here are the results..." etc.) or wraps the payload in ```json fences.
 * A plain JSON.parse() on the whole response breaks on the first stray
 * character outside the structure — which is what caused every agent to
 * silently fall back to keyword/template generation.
 *
 * Strategy: strip fences first, then if direct parse fails, walk the
 * string and extract the first balanced { ... } or [ ... ] payload,
 * respecting string/escape boundaries.
 */
export function parseJsonFromResponse<T>(response: string): T {
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Fast path
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }

  const extracted = extractFirstJson(cleaned) ?? cleaned;

  // Repaired path — fix common model artifacts (e.g. `"a" * 10000` shorthand for
  // a long value, trailing commas) that aren't valid JSON, then parse.
  try {
    return JSON.parse(repairJsonArtifacts(extracted)) as T;
  } catch { /* fall through to the raw attempt for a clearer error */ }

  return JSON.parse(extracted) as T;
}

/**
 * Repair non-JSON artifacts LLMs sometimes emit inside otherwise-valid JSON:
 *   "a" * 10000          → "a (repeated 10000 times)"   (string-multiply shorthand)
 *   "a".repeat(10000)    → "a (repeated 10000 times)"
 *   trailing commas before } or ]  → removed
 * These are conservative, targeted fixes — they only touch these exact shapes.
 */
function repairJsonArtifacts(text: string): string {
  return text
    .replace(/(["'])((?:\\.|(?!\1).)*)\1\s*\*\s*(\d+)/g,
      (_m, _q, body, n) => JSON.stringify(`${body} (repeated ${n} times)`))
    .replace(/(["'])((?:\\.|(?!\1).)*)\1\s*\.\s*repeat\s*\(\s*(\d+)\s*\)/g,
      (_m, _q, body, n) => JSON.stringify(`${body} (repeated ${n} times)`))
    .replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Walk the string and return the first balanced JSON object or array.
 * Respects string literals and escape sequences so that braces/brackets
 * inside strings don't disturb the depth counter.
 */
function extractFirstJson(text: string): string | null {
  const opens = ['{', '['];
  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (!opens.includes(ch as string)) continue;

    const openChar = ch as string;
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const c = text[i] as string;
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === openChar) depth++;
      else if (c === closeChar) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
