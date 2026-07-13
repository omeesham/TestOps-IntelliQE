#!/usr/bin/env node
/**
 * Pipeline Worker — polls backend for tasks, runs Claude agents.
 *
 * Per-tenant API keys: each task response carries the tenant's own Anthropic
 * API key (decrypted server-side). The worker uses that key if present;
 * otherwise it falls back to the platform-default `ANTHROPIC_API_KEY` env var.
 * This honors the HIPAA architecture requirement that customer-owned LLM
 * credentials live in the customer environment.
 *
 * Agent prompts (`*.agent.md`) are loaded from the directory pointed to by
 * `AGENTS_DIR` (defaults to `.github/agents` relative to repo root). Set this
 * env var to ship orchestration intelligence as a separate artifact.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { PipelineDefinition } from '../orchestrator/types.js';
import { callAnthropicAPI } from './sdk-executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const WORKER_SECRET = process.env.WORKER_SECRET || 'dev-secret';
const WORKER_ID = process.env.WORKER_ID || 'local-worker-1';
const PLATFORM_DEFAULT_API_KEY = process.env.ANTHROPIC_API_KEY;
const AGENTS_DIR = process.env.AGENTS_DIR
  ? path.resolve(process.env.AGENTS_DIR)
  : path.resolve(__dirname, '../..', '.github', 'agents');

interface TaskResponse {
  taskId: string;
  stageId: string;
  agentPrompt: string;
  context: Record<string, unknown> | null;
  runId: string;
  tenantId: string | null;
  tenantApiKey: string | null;
  stageConfig: {
    model: string;
    maxTurns: number;
    timeoutSeconds: number;
    budgetCap: number;
    agentFile: string;
    mcpConfig: string | null;
    allowedTools?: string[];
    effort?: 'low' | 'medium' | 'high' | 'max';
  } | null;
}

let config: PipelineDefinition['defaults'] | null = null;
let running = true;

const headers: Record<string, string> = {
  'x-worker-secret': WORKER_SECRET,
  'content-type': 'application/json',
};

async function loadConfig(): Promise<PipelineDefinition['defaults']> {
  if (config) return config;
  const localPath = path.join(__dirname, '../../config/pipeline-definition.json');
  if (fs.existsSync(localPath)) {
    const definition = JSON.parse(fs.readFileSync(localPath, 'utf-8')) as PipelineDefinition;
    config = definition.defaults;
    return config;
  }
  return {
    model: 'sonnet', maxTurnsPerStage: 50, budgetPerRunUsd: 2.00,
    budgetPerStageUsd: 0.50, workerPollIntervalMs: 5000,
    workerHeartbeatIntervalMs: 30000, cliPath: 'claude',
    cliOutputFormat: 'json', agentRunner: 'sdk' as const, autoInvoke: true,
  };
}

async function pollForTask(): Promise<TaskResponse | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/pipeline-worker/next-task`, { headers });
    if (!res.ok) return null;
    return await res.json() as TaskResponse | null;
  } catch { return null; }
}

async function completeTask(
  taskId: string,
  success: boolean,
  result: Record<string, unknown>,
  artifacts?: Array<{ name: string; type: string; content: string }>,
  cost?: number,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/pipeline-worker/complete-task`, {
        method: 'POST', headers,
        body: JSON.stringify({ taskId, success, result, artifacts, cost }),
      });
      if (res.ok) return;
    } catch {}
    if (attempt < 3) await sleep(2000);
  }
  console.error(`[Worker] CRITICAL: Task ${taskId} executed but could not be marked complete.`);
}

async function sendHeartbeat(currentTaskId?: string): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/pipeline-worker/heartbeat`, {
      method: 'POST', headers,
      body: JSON.stringify({ workerId: WORKER_ID, currentTaskId }),
    });
    if (res.ok) {
      const body = await res.json() as { ok: boolean; command?: string };
      if (body.command === 'stop' || body.command === 'restart') { running = false; }
    }
  } catch {}
}

function loadAgentFile(agentFile: string): string | null {
  // Backwards-compat: stage definitions reference paths like
  // ".github/agents/playwright-requirements.agent.md". Strip a leading
  // ".github/agents/" so we can re-root via AGENTS_DIR.
  const relative = agentFile
    .replace(/^\.?\/?\.github\/agents\//, '')
    .replace(/^\.?\/?agents\//, '');
  const agentPath = path.join(AGENTS_DIR, relative);
  try {
    let content = fs.readFileSync(agentPath, 'utf-8');
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3);
      if (endIdx !== -1) content = content.slice(endIdx + 3).trim();
    }
    return content;
  } catch {
    return null;
  }
}

async function executeTask(task: TaskResponse): Promise<{
  success: boolean;
  result: Record<string, unknown>;
  cost: number;
  artifacts: Array<{ name: string; type: string; content: string }>;
}> {
  // Prefer tenant-owned key (HIPAA: customer-owned LLM credentials),
  // fall back to platform default.
  const apiKey = task.tenantApiKey || PLATFORM_DEFAULT_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      result: { error: 'No Anthropic API key available (tenant key unset and ANTHROPIC_API_KEY missing)' },
      cost: 0,
      artifacts: [],
    };
  }

  const isDryRun = task.context?.dryRun === true;
  const agentInstructions = (!isDryRun && task.stageConfig?.agentFile)
    ? loadAgentFile(task.stageConfig.agentFile)
    : null;
  const systemMessage = agentInstructions
    ? agentInstructions + '\n\n---\n\nPipeline Stage: ' + task.stageId
    : `Pipeline Stage: ${task.stageId}`;

  const model = task.stageConfig?.model || 'sonnet';
  const timeout = (task.stageConfig?.timeoutSeconds || 600) * 1000;

  const sdkResult = await callAnthropicAPI(apiKey, model, systemMessage, task.agentPrompt, 4096, timeout);

  if (!sdkResult.success) {
    return {
      success: false,
      result: { error: sdkResult.error, inputTokens: sdkResult.inputTokens, outputTokens: sdkResult.outputTokens },
      cost: sdkResult.costUsd,
      artifacts: [{ name: `${task.stageId}-error.txt`, type: 'text', content: (sdkResult.error || 'Unknown error').slice(0, 50_000) }],
    };
  }

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(sdkResult.output); }
  catch { parsed = { rawOutput: sdkResult.output.slice(0, 10000) }; }

  return {
    success: true,
    result: { ...parsed, inputTokens: sdkResult.inputTokens, outputTokens: sdkResult.outputTokens },
    cost: sdkResult.costUsd,
    artifacts: [{ name: `${task.stageId}-output.json`, type: 'json', content: JSON.stringify(parsed, null, 2).slice(0, 50_000) }],
  };
}

async function workerLoop(): Promise<void> {
  const cfg = await loadConfig();
  let currentTaskId: string | undefined;

  console.log(`[Worker] Starting — backend: ${BACKEND_URL}, id: ${WORKER_ID}, agents: ${AGENTS_DIR}`);
  if (!PLATFORM_DEFAULT_API_KEY) {
    console.log('[Worker] No platform ANTHROPIC_API_KEY — relying entirely on per-tenant keys.');
  }

  const heartbeatTimer = setInterval(() => sendHeartbeat(currentTaskId), cfg.workerHeartbeatIntervalMs);
  await sendHeartbeat();

  while (running) {
    try {
      const task = await pollForTask();
      if (!task) { await sleep(cfg.workerPollIntervalMs); continue; }

      currentTaskId = task.taskId;
      console.log(`[Worker] Picked up task ${task.taskId} for stage "${task.stageId}" (run: ${task.runId})`);

      const result = await executeTask(task);

      if (task.context?.dryRun) result.result = { ...result.result, dryRun: true };
      if (task.context?.executionMode) result.result = { ...result.result, executionMode: task.context.executionMode };

      console.log(`[Worker] Task ${task.taskId}: ${result.success ? 'SUCCESS' : 'FAIL'}`);
      await completeTask(task.taskId, result.success, result.result, result.artifacts, result.cost);
      currentTaskId = undefined;
    } catch (err) {
      console.error(`[Worker] Loop error:`, (err as Error).message);
      await sleep(cfg.workerPollIntervalMs);
    }
  }

  clearInterval(heartbeatTimer);
  console.log('[Worker] Shutting down');
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

workerLoop().catch(err => { console.error('[Worker] Fatal:', err); process.exit(1); });
