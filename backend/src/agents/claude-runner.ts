/**
<<<<<<< HEAD
 * Claude runner — generates AI responses via the Anthropic API (official SDK).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ CLI INTEGRATION DISABLED (2026-06-27).                                    │
 * │ The platform now standardises on API keys configured in the UI            │
 * │ (System Configuration → LLM Configuration). API keys are durable,         │
 * │ headless, portable, and never expire — unlike an interactive              │
 * │ `claude auth login` session, which was the recurring "AI engine not       │
 * │ connected" failure. The legacy `claude` CLI fallback is preserved as a    │
 * │ commented-out block at the END of this file for historical reference      │
 * │ only. Do NOT re-enable it.                                                 │
 * │                                                                            │
 * │ The active API key is resolved from the DB by llm-config.service.ts and   │
 * │ hydrated into process.env.ANTHROPIC_API_KEY at startup / on config save / │
 * │ as a generate-route preflight. It can also be passed per call.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
=======
 * Claude CLI runner — invokes Claude Code to generate AI responses.
 *
 * Auth strategy (in priority order):
 *   1. ANTHROPIC_API_KEY set → Anthropic SDK (durable, headless, portable).
 *   2. Otherwise → locally-authenticated `claude` CLI (subscription login).
 *      The CLI path is fully async so the Node.js event loop is never blocked.
 */
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
>>>>>>> adedfc4 (ux changes)
import Anthropic from '@anthropic-ai/sdk';
// ── CLI fallback imports (disabled — see the commented block at end of file) ──
// import { execSync, spawn } from 'child_process';
// import { homedir } from 'os';
// import { join } from 'path';

export interface RunClaudeOptions {
  maxTokens?: number;
  model?: string;
  /**
   * Explicit Anthropic API key. Falls back to process.env.ANTHROPIC_API_KEY,
   * which is hydrated from the LLM Configuration page at startup / on save.
   */
  apiKey?: string;
  /** Optional custom API base URL (the LLM Configuration "endpoint" field). */
  baseUrl?: string;
}

<<<<<<< HEAD
/** Default model when neither the call site nor LLM Configuration specifies one. */
=======
/**
 * Run a prompt through Claude and return the response text.
 *
 * Auth strategy, in priority order:
 *   1. ANTHROPIC_API_KEY set → Anthropic SDK (durable, portable, preferred).
 *   2. Otherwise → locally-authenticated `claude` CLI (subscription login).
 */
export async function runClaudePrompt(
  prompt: string,
  options?: { maxTokens?: number; model?: string },
): Promise<string> {
  // Empty string is intentionally treated as "not set" so a placeholder
  // `ANTHROPIC_API_KEY=` line in .env falls through to the CLI fallback.
  if (process.env.ANTHROPIC_API_KEY) {
    return runViaAnthropicApi(prompt, options);
  }
  return runViaClaudeCli(prompt, options);
}

/** Default model for the API path; override with ANTHROPIC_MODEL (e.g. claude-sonnet-4-6 for lower cost). */
>>>>>>> adedfc4 (ux changes)
const DEFAULT_API_MODEL = 'claude-opus-4-8';

/**
 * Run a prompt through Claude (Anthropic API) and return the response text.
 * Returns a Promise — all call sites `await` it.
 */
export async function runClaudePrompt(prompt: string, options?: RunClaudeOptions): Promise<string> {
  return runViaAnthropicApi(prompt, options);
}

// Cache one SDK client per (apiKey, baseURL) pair so we don't rebuild it per call.
const clientCache = new Map<string, Anthropic>();
function getAnthropicClient(apiKey: string, baseURL?: string): Anthropic {
  const cacheKey = `${apiKey}::${baseURL || ''}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    // Generous timeout + retries so a long 16k-token generation can't trip the
    // SDK's default request bound.
    client = new Anthropic({
      apiKey,
      baseURL: baseURL || undefined,
      maxRetries: 2,
      timeout: 290_000,
    });
    clientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * Call the Anthropic Messages API via the official SDK. Streams and collects the
 * final message so that large `max_tokens` (the generator/script agents use
 * 16384) can't hit the SDK's non-streaming HTTP timeout.
 */
async function runViaAnthropicApi(prompt: string, options?: RunClaudeOptions): Promise<string> {
  const apiKey = options?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Worded so generate.routes' mapGenError() classifies it as "not authenticated".
    throw new Error(
      'Anthropic API not authenticated — no API key configured. ' +
        'Add your Anthropic Claude API key in System Configuration → LLM Configuration.',
    );
  }

  const baseURL = options?.baseUrl || process.env.ANTHROPIC_BASE_URL || undefined;
  // Precedence: the call site's explicit model wins (cheap stages deliberately
  // pin a fast model like sonnet); otherwise the model configured in LLM
  // Configuration (hydrated to ANTHROPIC_MODEL); otherwise the default.
  const model = options?.model || process.env.ANTHROPIC_MODEL || DEFAULT_API_MODEL;
  const maxTokens = options?.maxTokens ?? 4096;
  const client = getAnthropicClient(apiKey, baseURL);

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const message = await stream.finalMessage();

    let text = '';
    for (const block of message.content) {
      if (block.type === 'text') text += block.text;
    }
    text = text.trim();
    if (!text) throw new Error('Anthropic API returned an empty response');
    return text;
  } catch (err: any) {
    // Re-throw with messages the route's mapGenError() can classify into calm,
    // user-facing text (it keys on "not authenticated" / "rate limit" / "timeout").
    if (err instanceof Anthropic.AuthenticationError || err?.status === 401) {
      throw new Error(
        'Anthropic API not authenticated — the configured API key is missing or invalid. ' +
          'Check System Configuration → LLM Configuration.',
      );
    }
    if (err instanceof Anthropic.PermissionDeniedError || err?.status === 403) {
      throw new Error('Anthropic API not authenticated — this API key lacks access to the requested model.');
    }
    if (err instanceof Anthropic.RateLimitError || err?.status === 429) {
      throw new Error('Anthropic API rate limit reached — please retry in a moment.');
    }
    throw err;
  }
}

/**
<<<<<<< HEAD
 * Preflight used by callers before starting a pipeline. With the CLI removed,
 * "authenticated" means an Anthropic API key is present in the environment —
 * hydrated from LLM Configuration at startup / on config save / per request.
 *
 * Name kept for backward compatibility with existing call sites
 * (generate.routes, automation-scripts.routes, healing.service).
=======
 * Run a prompt through the Claude CLI and return the response text.
 * Uses `claude --print` (non-interactive print mode) with the prompt piped
 * via stdin. Fully async so the Node.js event loop is never blocked.
 */
async function runViaClaudeCli(prompt: string, options?: { maxTokens?: number; model?: string }): Promise<string> {
  const cli = findClaudeCli();
  if (!cli) throw new Error('Claude CLI not found');

  const args: string[] = ['--print'];
  if (options?.model) args.push('--model', options.model);

  return new Promise<string>((resolve, reject) => {
    // On Windows, .cmd files require cmd.exe as the interpreter; pass shell
    // explicitly via cmd /c instead of `shell: true` to avoid DEP0190.
    const [spawnCmd, spawnArgs] = IS_WINDOWS
      ? ['cmd', ['/c', cli, ...args]]
      : [cli, args];

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid);
      reject(new Error(`Claude CLI timed out after 5 minutes (tree-killed pid ${child.pid})`));
    }, 300_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error('Claude CLI returned an empty response'));
        return;
      }
      resolve(text);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Send the prompt via stdin and close to signal EOF
    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();
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

/**
 * Check if Claude is actually usable — i.e. the CLI is present AND authenticated.
 *
 * `isClaudeCliAvailable()` only proves the binary exists; `claude -p` still fails
 * with "Not logged in" until the user runs `claude auth login`. The generation
 * agents have no offline fallback, so callers should preflight with THIS before
 * starting a pipeline to fail fast with an actionable message instead of a deep
 * JSON-parse error. An ANTHROPIC_API_KEY in the environment also satisfies auth.
>>>>>>> adedfc4 (ux changes)
 */
export function isClaudeCliAuthenticated(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * @deprecated The Claude CLI integration is disabled — always returns false.
 * Kept only so any stray import keeps compiling.
 */
export function isClaudeCliAvailable(): boolean {
  return false;
}

/**
 * Parse JSON from Claude's response.
 *
 * Claude sometimes returns JSON followed by trailing prose or wraps the payload
 * in ```json fences. A plain JSON.parse() on the whole response breaks on the
 * first stray character outside the structure.
 *
 * Strategy: strip fences first, then if direct parse fails, walk the string and
 * extract the first balanced { ... } or [ ... ] payload, respecting
 * string/escape boundaries.
 */
export function parseJsonFromResponse<T>(response: string): T {
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Fast path
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }

  const extracted = extractFirstJson(cleaned);
  if (extracted === null) {
    throw new Error('No JSON object or array found in response');
  }
  return JSON.parse(extracted) as T;
}

export interface RunClaudeJsonOptions extends RunClaudeOptions {
  /** How many times to call Claude before giving up (default 2). */
  attempts?: number;
}

/**
 * Run a prompt and parse a JSON object/array from the response, retrying on
 * parse failures (truncated output, stray prose, empty reply). LLM responses are
 * non-deterministic, so a fresh sample usually parses where the previous one did
 * not — this is what makes the generation pipeline reliable instead of failing a
 * whole run on one flaky reply. Auth / rate-limit / permission errors are NOT
 * retried (they won't fix themselves) and propagate immediately.
 */
export async function runClaudeJson<T>(prompt: string, options?: RunClaudeJsonOptions): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? 2);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // On a retry, reinforce the "JSON only, complete" instruction — the prior
      // reply likely carried prose or was cut off mid-structure.
      const p = attempt === 1
        ? prompt
        : `${prompt}\n\nIMPORTANT: Return ONLY the JSON value — no prose, no markdown fences, no commentary — and make sure it is COMPLETE and valid.`;
      const response = await runClaudePrompt(p, options);
      return parseJsonFromResponse<T>(response);
    } catch (err) {
      lastErr = err;
      const msg = ((err as Error)?.message || '').toLowerCase();
      if (msg.includes('not authenticated') || msg.includes('rate limit') || msg.includes('lacks access')) {
        throw err;
      }
      // Parse failure / empty / truncated → loop and try once more.
    }
  }
  throw lastErr;
}

/**
 * Walk the string and return the first balanced JSON object or array.
 * Respects string literals and escape sequences so that braces/brackets inside
 * strings don't disturb the depth counter.
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

/* ============================================================================
 * DISABLED — legacy Claude CLI fallback (commented out 2026-06-27).
 *
 * Standardising on API keys (LLM Configuration) replaced this path. The CLI
 * login token expired periodically, causing the recurring "AI engine not
 * connected" failures. Kept verbatim for reference only — do NOT re-enable.
 *
 * import { execSync, spawn } from 'child_process';
 * import { homedir } from 'os';
 * import { join } from 'path';
 *
 * let resolvedCliPath: string | null = null;
 * const IS_WINDOWS = process.platform === 'win32';
 *
 * function findClaudeCli(): string | null {
 *   if (resolvedCliPath) return resolvedCliPath;
 *   const candidates = [
 *     'claude',
 *     join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
 *     join(homedir(), '.npm-global', 'bin', 'claude'),
 *     '/usr/local/bin/claude',
 *   ];
 *   for (const cmd of candidates) {
 *     try {
 *       execSync(`"${cmd}" --version`, { timeout: 5000, encoding: 'utf-8', stdio: 'pipe' });
 *       resolvedCliPath = cmd;
 *       return cmd;
 *     } catch { /* try next *\/ }
 *   }
 *   return null;
 * }
 *
 * function runViaClaudeCli(prompt: string, options?: { maxTokens?: number; model?: string }): Promise<string> {
 *   return new Promise<string>((resolve, reject) => {
 *     const cli = findClaudeCli();
 *     if (!cli) { reject(new Error('Claude CLI not found')); return; }
 *     const model = options?.model || process.env.CLAUDE_CLI_MODEL || 'sonnet';
 *     const args = ['-p', '--model', model];
 *     const cliTimeoutMs = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 900_000;
 *     const child = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WINDOWS, windowsHide: true });
 *     let stdout = ''; let stderr = ''; let settled = false;
 *     let timer: ReturnType<typeof setTimeout>;
 *     const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
 *     timer = setTimeout(() => finish(() => {
 *       if (child.pid) treeKill(child.pid);
 *       reject(new Error(`Claude CLI timed out after ${Math.round(cliTimeoutMs / 60000)} minutes`));
 *     }), cliTimeoutMs);
 *     child.stdout.on('data', (d) => { stdout += d.toString(); });
 *     child.stderr.on('data', (d) => { stderr += d.toString(); });
 *     child.on('error', (err) => finish(() => reject(err)));
 *     child.on('close', (code) => finish(() => {
 *       if (code !== 0) reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
 *       else resolve(stdout.trim());
 *     }));
 *     child.stdin.on('error', () => { /* ignore EPIPE *\/ });
 *     child.stdin.write(prompt);
 *     child.stdin.end();
 *   });
 * }
 *
 * function treeKill(pid: number): void {
 *   if (IS_WINDOWS) {
 *     try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 }); } catch { /* already dead *\/ }
 *   } else {
 *     try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead *\/ }
 *   }
 * }
 *
 * // Old isClaudeCliAuthenticated() also accepted a logged-in CLI:
 * //   if (process.env.ANTHROPIC_API_KEY) return true;
 * //   const cli = findClaudeCli();
 * //   if (!cli) return false;
 * //   try { return JSON.parse(execSync(`"${cli}" auth status`, ...).trim()).loggedIn === true; }
 * //   catch { return false; }
 * ========================================================================== */
