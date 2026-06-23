/**
 * gate-runner
 * ───────────
 * Pipeline stages can declare `preRunGate` and `postCompleteGate` script
 * paths in pipeline-definition.json. When a non-empty path is configured,
 * the orchestrator MUST execute that script before/after the stage and
 * honour its exit code as the pass/fail signal.
 *
 * Previous behaviour (now removed): the function always returned
 * `passed: true` regardless of the script, which silently bypassed every
 * gate ever configured. This file now executes the script for real via
 * `child_process.spawnSync` and surfaces the real outcome.
 *
 *   • Exit 0  → passed
 *   • Non-zero → failed (stdout + stderr returned for diagnostics)
 *   • Spawn error → failed with a clear message
 *   • Empty gateScript → passed (nothing was configured to check)
 */
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface GateResult {
  passed: boolean;
  output: string;
  exitCode?: number;
}

// Hard timeout — protect the orchestrator from a runaway gate script.
const GATE_TIMEOUT_MS = 120_000;

export function runGate(gateScript: string, args: string[] = []): GateResult {
  if (!gateScript || !gateScript.trim()) {
    // No gate configured — there is literally nothing to verify, so this
    // is an honest pass, not a lie.
    return { passed: true, output: 'No gate configured — nothing to check' };
  }

  // Reject obvious shell-injection attempts. The script path may be
  // absolute or relative to the backend cwd; either way it must be a
  // single command, not a pipeline.
  if (/[;&|`$]/.test(gateScript)) {
    return {
      passed: false,
      output: `Gate script rejected: contains shell metacharacters (${gateScript})`,
    };
  }

  // Resolve relative paths against the backend root so the orchestrator
  // can be launched from anywhere.
  const resolved = path.isAbsolute(gateScript)
    ? gateScript
    : path.resolve(process.cwd(), gateScript);

  if (!fs.existsSync(resolved)) {
    return {
      passed: false,
      output: `Gate script not found: ${resolved}`,
    };
  }

  // Decide how to invoke the file. JS / TS / PY / SH all get their proper
  // interpreter; anything else is executed directly (must be a binary or
  // shebang script).
  const ext = path.extname(resolved).toLowerCase();
  let cmd: string;
  let runArgs: string[];
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    cmd = process.execPath;          // current node binary
    runArgs = [resolved, ...args];
  } else if (ext === '.ts') {
    cmd = 'npx';
    runArgs = ['tsx', resolved, ...args];
  } else if (ext === '.py') {
    cmd = process.platform === 'win32' ? 'python' : 'python3';
    runArgs = [resolved, ...args];
  } else if (ext === '.sh' && process.platform !== 'win32') {
    cmd = 'bash';
    runArgs = [resolved, ...args];
  } else if (ext === '.bat' || ext === '.cmd') {
    cmd = resolved;
    runArgs = args;
  } else {
    cmd = resolved;
    runArgs = args;
  }

  const result = spawnSync(cmd, runArgs, {
    encoding: 'utf-8',
    timeout: GATE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    shell: process.platform === 'win32' && (ext === '.bat' || ext === '.cmd'),
    windowsHide: true,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ETIMEDOUT') {
      return { passed: false, output: `Gate script timed out after ${GATE_TIMEOUT_MS / 1000}s: ${resolved}` };
    }
    return { passed: false, output: `Gate script could not start (${err.code || 'unknown'}): ${err.message}` };
  }

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)';
  const passed = result.status === 0;

  return { passed, output, exitCode: result.status ?? undefined };
}
