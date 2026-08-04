/**
 * Claude CLI runner — invokes Claude Code to generate AI responses.
 * Falls back to a basic prompt-based approach if CLI is not available.
 *
 * NOTE: Originally used execSync/spawnSync, which blocked the Node event loop
 * for the whole CLI call — one running pipeline froze every other request
 * (even /api/health) for minutes. Now uses async spawn so the API stays
 * responsive while the CLI works. The manual timeout still issues
 * `taskkill /F /T /PID` on Windows (or `kill -9 -pid` on POSIX) so the whole
 * process tree dies and no orphaned claude.exe can accumulate overnight.
 */
import { execSync, spawn } from 'child_process';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { LlmConfig } from './state.js';
export type { LlmConfig };

const IS_WINDOWS = process.platform === 'win32';

/**
 * A resolved CLI target. `useShell` matters more than it looks: with
 * `shell: true` Node only CONCATENATES argv into a command string, so an
 * empty-string argument vanishes — `--tools ''` silently degraded to a bare
 * `--tools`, leaving every tool enabled (the cause of the 5-minute hangs).
 * Spawning the native binary with `shell: false` keeps argv exact; the shell
 * fallback has to spell the empty value as literal quotes instead.
 */
interface ResolvedCli {
  cmd: string;
  useShell: boolean;
}

let resolvedCli: ResolvedCli | null = null;

function findClaudeCli(): ResolvedCli | null {
  if (resolvedCli) return resolvedCli;

  const candidates: ResolvedCli[] = [];
  if (IS_WINDOWS) {
    // Native binary FIRST. The npm `claude.cmd` shim does nothing but forward
    // to this exe, so targeting it directly buys us a shell-free spawn.
    candidates.push({ cmd: join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), useShell: false });
    candidates.push({ cmd: join(homedir(), '.local', 'bin', 'claude.exe'), useShell: false });
  }
  candidates.push({ cmd: 'claude', useShell: IS_WINDOWS });
  candidates.push({ cmd: join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'), useShell: true });
  candidates.push({ cmd: join(homedir(), '.npm-global', 'bin', 'claude'), useShell: false });
  candidates.push({ cmd: '/usr/local/bin/claude', useShell: false });

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate.cmd}" --version`, { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' });
      resolvedCli = candidate;
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Wall-clock budget for one CLI call, scaled by how much OUTPUT is expected.
 * A fixed 5-minute cap killed the generator mid-write: it asks for up to 64k
 * tokens of JSON test cases, which legitimately streams for longer than that,
 * while short analysis calls (4-8k) finish in well under a minute. Budget ~90s
 * per 8k output tokens, floored at 5 min and ceilinged at 15 min — the same
 * order as the Messages API path (10 min) and within the client's own window.
 */
function cliTimeoutFor(maxTokens: number | undefined): number {
  const scaled = Math.ceil((maxTokens || 4096) / 8000) * 90_000;
  return Math.min(900_000, Math.max(300_000, scaled));
}

/**
 * Run a prompt through Claude CLI and return the response text.
 * Uses `claude -p` (print mode — non-interactive, returns text).
 *
 * Async spawn — the event loop keeps serving other requests while the CLI
 * runs. On timeout we tree-kill (`taskkill /F /T` on Windows) because Node's
 * own kill only reaches the immediate child, not the helper processes the
 * CLI spawns.
 */
export function runClaudePrompt(prompt: string, options?: { maxTokens?: number; model?: string; oauthToken?: string; timeoutMs?: number }): Promise<string> {
  const cli = findClaudeCli();
  if (!cli) return Promise.reject(new Error('Claude CLI not found'));

  const timeoutMs = options?.timeoutMs ?? cliTimeoutFor(options?.maxTokens);

  // An empty --tools value disables every built-in tool (Bash/Read/Grep/Edit/…)
  // and --safe-mode skips CLAUDE.md / memory / skills / plugin discovery.
  // Without these, `claude -p` still behaves like a full agentic coding session
  // — free to wander off exploring a codebase with tools for what should be a
  // single stateless text/JSON completion — which is what was exhausting the
  // 5-minute timeout on real prompts. Through a shell the empty value must be
  // written as literal quotes, since Node's argv concatenation drops '' (see
  // ResolvedCli).
  const args: string[] = ['-p', '--tools', cli.useShell ? '""' : '', '--safe-mode'];
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

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cli.cmd, args, {
      // Run from outside the repo so the CLI can't pick up this project's own
      // CLAUDE.md as context (belt-and-braces alongside --safe-mode).
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: cli.useShell,
      windowsHide: true,
      env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid);
      const mins = Math.round(timeoutMs / 60000);
      settle(() => reject(new Error(`Claude CLI timed out after ${mins} minute${mins === 1 ? '' : 's'} (tree-killed pid ${child.pid})`)));
    }, timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => {
      if (code === 0) {
        settle(() => resolve(stdout.trim()));
      } else {
        const detail = `${stderr}${stderr && stdout ? ' | ' : ''}${stdout}`.trim();
        settle(() => reject(new Error(`Claude CLI exited with code ${code}: ${detail.slice(0, 800) || '(no output)'}`)));
      }
    });

    // EPIPE if the child dies before reading stdin — the close handler reports it.
    child.stdin.on('error', () => { /* ignore */ });
    child.stdin.end(prompt);
  });
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

  // Claude Code (subscription). The admin picks the transport in the UI:
  //   - 'cli' → run through the logged-in local `claude` CLI (no per-token API
  //             cost — for local testing on a machine with Claude installed).
  //   - 'api' → OAuth token against the Messages API (default; works on Azure).
  if (method === 'claude_code') {
    const mode = llm?.claudeCodeMode || 'api';
    if (mode === 'cli') {
      if (!isClaudeCliAvailable()) {
        throw new Error(
          'Claude Code is set to CLI mode, but the `claude` CLI is not available on this server. ' +
          'Install and log in the Claude CLI here, or switch Claude Code to API mode in System Configuration → LLM Configuration.',
        );
      }
      // Pass the RESOLVED maxTokens — it sizes the CLI's wall-clock budget
      // (cliTimeoutFor), so leaving it undefined would under-budget a large
      // generation and kill it mid-write.
      return runClaudePrompt(prompt, { maxTokens, model, oauthToken: llm?.oauthToken });
    }
    // API mode.
    if (llm?.oauthToken) {
      return callApi({ authMethod: 'claude_code', oauthToken: llm.oauthToken, model, baseUrl, maxTokens, system: options?.system, effort: llm?.effort, extendedThinking: llm?.extendedThinking });
    }
    if (isClaudeCliAvailable()) {
      return runClaudePrompt(prompt, { maxTokens, model, oauthToken: llm?.oauthToken });
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
    return runClaudePrompt(prompt, { maxTokens, model: llm?.model });
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
 * Coerce a parsed LLM payload into an array. Models drift on shape: asked for a
 * bare array, they periodically wrap it in an object ({ "testCases": [...] },
 * { "data": [...] }). Rejecting those shapes fails whole pipeline stages for a
 * formatting quirk — unwrap instead. Returns null when no array is present.
 */
export function coerceJsonArray<T>(parsed: unknown): T[] | null {
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const preferredKeys = ['testCases', 'test_cases', 'tests', 'cases', 'items', 'data', 'results', 'specs'];
    for (const k of preferredKeys) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
    // Exactly one array-valued property → unambiguous, take it.
    const arrays = Object.values(obj).filter((v): v is unknown[] => Array.isArray(v));
    if (arrays.length === 1) return arrays[0] as T[];
  }
  return null;
}

/**
 * Salvage the complete top-level objects of a JSON array whose tail is broken —
 * typically a response truncated at max_tokens mid-element. Every fully-closed
 * `{...}` element parses individually; the torn final element is dropped. This
 * turns "SyntaxError → entire stage failed" into "N-1 usable results".
 */
export function salvageJsonArrayObjects<T>(text: string): T[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const start = cleaned.indexOf('[');
  if (start === -1) return [];
  const out: T[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;
  for (let i = start + 1; i < cleaned.length; i++) {
    const c = cleaned[i] as string;
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(repairJsonArtifacts(cleaned.slice(objStart, i + 1))) as T); }
        catch { /* malformed element — skip it, keep the rest */ }
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) {
      break; // array closed cleanly
    }
  }
  return out;
}

/**
 * Repair non-JSON artifacts LLMs sometimes emit inside otherwise-valid JSON:
 *   "a" * 10000          → "a (repeated 10000 times)"   (string-multiply shorthand)
 *   "a".repeat(10000)    → "a (repeated 10000 times)"
 *   trailing commas before } or ]  → removed
 * These are conservative, targeted fixes — they only touch these exact shapes.
 *
 * The quoted-string body is matched with the unrolled, unambiguous form
 * `(?:[^"\\]|\\.)*` (one branch per input char) rather than a nested quantifier
 * over a negative-lookahead. The old `(?:\\.|(?!\1).)*` was ambiguous on
 * backslash runs and backtracked exponentially — a generated Playwright spec
 * (escapes, regex literals) could peg the event loop at 100% CPU for minutes,
 * timing out every other request. Split per quote char since a backreference
 * can't appear inside a character class.
 */
function repairJsonArtifacts(text: string): string {
  return text
    .replace(/"((?:[^"\\]|\\.)*)"\s*\*\s*(\d+)/g,
      (_m, body, n) => JSON.stringify(`${body} (repeated ${n} times)`))
    .replace(/'((?:[^'\\]|\\.)*)'\s*\*\s*(\d+)/g,
      (_m, body, n) => JSON.stringify(`${body} (repeated ${n} times)`))
    .replace(/"((?:[^"\\]|\\.)*)"\s*\.\s*repeat\s*\(\s*(\d+)\s*\)/g,
      (_m, body, n) => JSON.stringify(`${body} (repeated ${n} times)`))
    .replace(/'((?:[^'\\]|\\.)*)'\s*\.\s*repeat\s*\(\s*(\d+)\s*\)/g,
      (_m, body, n) => JSON.stringify(`${body} (repeated ${n} times)`))
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
