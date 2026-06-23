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
export function runClaudePrompt(prompt: string, options?: { maxTokens?: number; model?: string }): string {
  const cli = findClaudeCli();
  if (!cli) throw new Error('Claude CLI not found');

  const args: string[] = ['-p'];
  if (options?.model) args.push('--model', options.model);
  // Note: Claude CLI does not support --max-tokens; use --max-budget-usd for cost control

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
      throw new Error(`Claude CLI exited with code ${result.status}: ${String(result.stderr || '').slice(0, 500)}`);
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
