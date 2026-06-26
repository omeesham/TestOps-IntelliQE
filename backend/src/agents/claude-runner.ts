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
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

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
 * Run a prompt through Claude and return the response text.
 *
 * Auth strategy, in priority order:
 *   1. ANTHROPIC_API_KEY set → call the Anthropic API directly via the official
 *      SDK. This is the durable, portable path: API keys don't expire like an
 *      interactive `claude auth login` session, they work headlessly, and
 *      anyone who clones the repo can run the pipeline by setting their own key.
 *      PREFERRED.
 *   2. Otherwise → shell out to the locally-authenticated `claude` CLI
 *      (subscription login). Kept as a fallback so existing CLI setups keep
 *      working — but its login token expires periodically, which is the failure
 *      the API-key path above is meant to eliminate.
 *
 * Returns a Promise now (the SDK is async). All call sites `await` it.
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
const DEFAULT_API_MODEL = 'claude-opus-4-8';

let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    // Reads ANTHROPIC_API_KEY from the environment. Generous timeout + retries
    // so a long 16k-token generation can't trip the SDK's default request bound.
    anthropicClient = new Anthropic({ maxRetries: 2, timeout: 290_000 });
  }
  return anthropicClient;
}

/**
 * Call the Anthropic Messages API via the official SDK. Streams and collects the
 * final message so that large `max_tokens` (the generator/script agents use
 * 16384) can't hit the SDK's non-streaming HTTP timeout.
 */
async function runViaAnthropicApi(
  prompt: string,
  options?: { maxTokens?: number; model?: string },
): Promise<string> {
  const client = getAnthropicClient();
  const model = process.env.ANTHROPIC_MODEL || options?.model || DEFAULT_API_MODEL;
  const maxTokens = options?.maxTokens ?? 4096;

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
      throw new Error('Anthropic API not authenticated — ANTHROPIC_API_KEY is missing or invalid.');
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
 * Run a prompt through the Claude CLI and return the response text.
 * Uses `claude -p` (print mode — non-interactive, returns text).
 *
 * ASYNC (child_process.spawn) so it does NOT block the Node event loop. This is
 * what lets independent calls — e.g. script-generation batches — run in PARALLEL,
 * and keeps the backend responsive (SSE, other requests) during long generations
 * instead of freezing it. The prompt is fed via stdin (no shell-escaping issues).
 *
 * Model defaults to a FAST one (sonnet) because the CLI otherwise picks the slow
 * Opus default; override per-call or via CLAUDE_CLI_MODEL (e.g. 'opus' for max
 * quality, 'haiku' for max speed). Timeout via CLAUDE_CLI_TIMEOUT_MS (default
 * 15 min); on timeout the whole process tree is killed so no orphans linger.
 */
function runViaClaudeCli(prompt: string, options?: { maxTokens?: number; model?: string }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const cli = findClaudeCli();
    if (!cli) { reject(new Error('Claude CLI not found')); return; }

    const model = options?.model || process.env.CLAUDE_CLI_MODEL || 'sonnet';
    const args = ['-p', '--model', model];
    const cliTimeoutMs = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 900_000; // 15 min

    const child = spawn(cli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,   // .cmd shim needs a shell on Windows
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

    timer = setTimeout(() => finish(() => {
      if (child.pid) treeKill(child.pid);
      reject(new Error(`Claude CLI timed out after ${Math.round(cliTimeoutMs / 60000)} minutes`));
    }), cliTimeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => {
      if (code !== 0) reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout.trim());
    }));

    // Feed the prompt via stdin. Swallow EPIPE if the child exits before we finish writing.
    child.stdin.on('error', () => { /* ignore */ });
    child.stdin.write(prompt);
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
 */
export function isClaudeCliAuthenticated(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  const cli = findClaudeCli();
  if (!cli) return false;
  try {
    const out = execSync(`"${cli}" auth status`, { timeout: 10000, encoding: 'utf-8', stdio: 'pipe' });
    return JSON.parse(out.trim()).loggedIn === true;
  } catch {
    return false;
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

  const extracted = extractFirstJson(cleaned);
  if (extracted === null) {
    throw new Error('No JSON object or array found in response');
  }
  return JSON.parse(extracted) as T;
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
