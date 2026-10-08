/**
 * api-orchestrator.service.ts
 * ───────────────────────────
 * The "AI Coworker" — a single conversational orchestrator layered OVER the
 * discrete API tools (author, chat-refine, generate, diagnose, maintenance,
 * coverage, impact). An LLM classifies a plain-English message into one intent
 * and drafts a reply; ANALYSIS intents (coverage / maintenance / impact) are
 * executed here and their results attached, while ACTION intents return a
 * proposed plan the UI can one-click run through the existing flows. Nothing is
 * executed destructively on the user's behalf.
 *
 * Plus opt-in EVENT AUTONOMY: a token-gated webhook (GitHub PR / Jira sprint)
 * records the event and, when the tenant has enabled a matching trigger, flags a
 * suggested maintenance pass for the UI to surface — capture-and-surface, never
 * a runaway background actor.
 *
 * Standalone and opt-in: own tables, reuses existing analysis services + the
 * shared LLM runner; the generate → execute → heal pipeline is never altered.
 */
import { randomBytes } from 'crypto';
import pool from '../db.js';
import { runLLM, parseJsonFromResponse } from '../agents/claude-runner.js';
import { planMaintenance } from './api-maintenance.service.js';
import { analyzeCoverageGaps } from './api-coverage-gaps.service.js';
import { analyzeImpactDeep } from './api-impact.service.js';
import { optimizeSuite } from './api-suite-optimizer.service.js';

export type OrchestratorIntent =
  | 'author' | 'refine' | 'generate' | 'diagnose' | 'maintenance' | 'coverage' | 'impact' | 'chat'
  // Atto coworker — the new lifecycle tools the orchestrator can also drive:
  | 'optimize' | 'story' | 'heal' | 'bugreport' | 'multimodal' | 'monitor';
const INTENTS: OrchestratorIntent[] = [
  'author', 'refine', 'generate', 'diagnose', 'maintenance', 'coverage', 'impact', 'chat',
  'optimize', 'story', 'heal', 'bugreport', 'multimodal', 'monitor',
];
/** Intents whose read-only analysis the orchestrator runs inline. The rest return a plan the UI opens. */
const ANALYSIS_INTENTS = new Set<OrchestratorIntent>(['coverage', 'maintenance', 'impact', 'optimize']);

export interface OrchestrateInput {
  message: string;
  endpoints?: any[];
  changed?: { method?: string; url: string }[];
  history?: { role: 'user' | 'assistant'; content: string }[];
}
export interface OrchestrateResult {
  reply: string;
  intent: OrchestratorIntent;
  plan?: { action: OrchestratorIntent; params?: Record<string, unknown> };
  data?: unknown;
}

function catalogueSummary(endpoints: any[]): string {
  if (!endpoints.length) return '(the catalogue is currently empty)';
  const byMethod: Record<string, number> = {};
  for (const e of endpoints) { const m = String(e.method || 'GET').toUpperCase(); byMethod[m] = (byMethod[m] || 0) + 1; }
  const sample = endpoints.slice(0, 20).map((e) => `${String(e.method || 'GET').toUpperCase()} ${e.url}`).join('\n');
  return `${endpoints.length} endpoints (${Object.entries(byMethod).map(([m, n]) => `${m}:${n}`).join(', ')}). First few:\n${sample}`;
}

function mapForMaintenance(endpoints: any[]): any[] {
  return endpoints
    .filter((e) => e && /^https?:\/\//i.test(String(e.url || '')))
    .slice(0, 500)
    .map((e) => ({
      id: String(e.id || ''),
      title: typeof e.title === 'string' ? e.title : undefined,
      method: String(e.method || 'GET').toUpperCase(),
      url: String(e.url),
      headers: Array.isArray(e.headers) ? e.headers : [],
      auth: e.auth,
      body: typeof e.body === 'string' ? e.body : undefined,
      expectedStatus: Number.isInteger(Number(e.expectedStatus)) ? Number(e.expectedStatus) : undefined,
      expectedResponse: typeof e.expectedResponse === 'string' ? e.expectedResponse : undefined,
    }));
}

const SYSTEM = `You are IntelliQE's API-testing coworker ("Atto"). You route a user's plain-English request to ONE capability and reply briefly and concretely. Capabilities (intents):
- author: turn a description into a test-generation brief
- refine: adjust/add cases to an existing test in plain English
- generate: design/generate test scenarios for the catalogue
- diagnose: explain a failing request / find root cause
- maintenance: scan drift + coverage and propose a reviewable changeset
- coverage: find endpoints with real traffic but no test
- impact: given changed endpoints, select the tests that exercise them (history- & flow-aware)
- optimize: rank the suite by risk and find redundant/duplicate tests to prune
- story: turn a Jira story / PRD / acceptance criteria into a test plan
- heal: semantically self-heal a failing test (regression vs. contract-evolution)
- bugreport: assemble a tracker-ready bug report from a failure
- multimodal: derive tests from a screenshot / Figma export / recording transcript
- monitor: set up or review the always-on monitoring loop
- chat: a general question that needs no tool
Reply ONLY with JSON: {"intent": <one of the above>, "reply": <1-3 sentence answer to the user>, "params": {<optional hints, e.g. "focus": "...">}}. Never invent results; if a tool must run to answer, pick its intent and keep the reply about what you're doing.`;

export async function orchestrate(tenantId: string, input: OrchestrateInput, llm: any): Promise<OrchestrateResult> {
  if (!llm) throw new Error('The AI coworker needs an LLM — add one under System Configuration → LLM, or an API-automation LLM provider.');
  const endpoints = Array.isArray(input.endpoints) ? input.endpoints : [];
  const history = Array.isArray(input.history) ? input.history.slice(-6) : [];
  const convo = history.map((h) => `${h.role === 'assistant' ? 'Coworker' : 'User'}: ${String(h.content || '').slice(0, 1000)}`).join('\n');
  const prompt = [
    convo ? `Conversation so far:\n${convo}\n` : '',
    `Catalogue: ${catalogueSummary(endpoints)}`,
    `User: ${String(input.message || '').slice(0, 4000)}`,
  ].filter(Boolean).join('\n\n');

  let decision: { intent?: string; reply?: string; params?: Record<string, unknown> };
  try {
    const raw = await runLLM(prompt, { system: SYSTEM, llm, maxTokens: 1200 });
    try { decision = parseJsonFromResponse(raw); } catch { decision = { intent: 'chat', reply: raw.slice(0, 1200) }; }
  } catch (e) {
    throw new Error(`The coworker's LLM call failed: ${(e as Error).message}`);
  }
  const intent: OrchestratorIntent = (INTENTS.includes(decision.intent as OrchestratorIntent) ? decision.intent : 'chat') as OrchestratorIntent;
  let reply = String(decision.reply || '').trim();

  let data: unknown;
  let plan: OrchestrateResult['plan'];
  try {
    if (intent === 'coverage') {
      data = await analyzeCoverageGaps(tenantId, mapForMaintenance(endpoints) as any);
    } else if (intent === 'maintenance') {
      data = await planMaintenance(tenantId, mapForMaintenance(endpoints) as any, { explain: false });
    } else if (intent === 'impact') {
      const changed = Array.isArray(input.changed) ? input.changed.filter((c) => c && c.url).map((c) => ({ method: c.method, url: String(c.url) })) : [];
      const candidates = endpoints.filter((e) => e && /^https?:\/\//i.test(String(e.url || ''))).map((e) => ({ id: e.id ? String(e.id) : undefined, title: e.title ? String(e.title) : undefined, method: String(e.method || 'GET').toUpperCase(), url: String(e.url) }));
      // History- & flow-aware impact (falls back to structural when there's no history/flows).
      data = await analyzeImpactDeep(tenantId, { changed, candidates });
    } else if (intent === 'optimize') {
      const candidates = endpoints.filter((e) => e && /^https?:\/\//i.test(String(e.url || ''))).map((e) => ({ id: e.id ? String(e.id) : undefined, title: e.title ? String(e.title) : undefined, method: String(e.method || 'GET').toUpperCase(), url: String(e.url), auth: e.auth }));
      data = await optimizeSuite(tenantId, candidates as any);
    } else if (!ANALYSIS_INTENTS.has(intent) && intent !== 'chat') {
      // Action intents (author/refine/generate/diagnose/story/heal/bugreport/multimodal/monitor)
      // return a plan the UI one-click opens in the matching tool.
      plan = { action: intent, params: decision.params || {} };
    }
  } catch (e) {
    reply = `${reply ? reply + ' ' : ''}(I tried to run ${intent} but it failed: ${(e as Error).message})`;
  }
  if (!reply) reply = defaultReply(intent);
  return { reply, intent, plan, data };
}

function defaultReply(intent: OrchestratorIntent): string {
  switch (intent) {
    case 'coverage': return 'I checked recorded traffic against your tested endpoints — see the coverage gaps below.';
    case 'maintenance': return 'I scanned for drift and coverage gaps and drafted a reviewable changeset below.';
    case 'impact': return 'I selected the tests that exercise the changed endpoints below.';
    case 'optimize': return 'I ranked the suite by risk and found the redundant tests to prune — see below.';
    case 'author': return 'I can turn that into a generation brief — open Author to run it.';
    case 'refine': return 'I can refine that test — open Chat-to-test to iterate.';
    case 'generate': return 'I can design scenarios for the selected endpoints — start a generation run.';
    case 'diagnose': return 'Point me at a failing run and I will find the root cause.';
    case 'story': return 'Paste a Jira story or PRD and I will turn it into a test plan — open Story generation.';
    case 'heal': return 'I can semantically heal a failing test — open Self-healing to review proposals.';
    case 'bugreport': return 'I can assemble a tracker-ready bug report from a failure — open Bug report.';
    case 'multimodal': return 'Share a screenshot, Figma export or recording and I will derive tests — open Multimodal.';
    case 'monitor': return 'I can set up the always-on monitoring loop — open Monitoring.';
    default: return 'Here to help with your API tests.';
  }
}

/* ────────────────────────────────────────────────────────────────
   Event autonomy — config, token, event log (opt-in)
   ──────────────────────────────────────────────────────────────── */

export interface OrchestratorConfigView { enabled: boolean; triggers: string[]; action: string; hasToken: boolean; token?: string; eventPath: string }
const DEFAULT_TRIGGERS = ['pull_request', 'sprint_started'];

export async function getOrchestratorConfig(tenantId: string): Promise<OrchestratorConfigView> {
  const { rows } = await pool.query(`SELECT enabled, triggers, action, token FROM api_orchestrator_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) return { enabled: false, triggers: DEFAULT_TRIGGERS, action: 'maintenance', hasToken: false, eventPath: '/agent-event' };
  const r = rows[0];
  const triggers = (() => { try { return typeof r.triggers === 'string' ? JSON.parse(r.triggers) : (r.triggers || DEFAULT_TRIGGERS); } catch { return DEFAULT_TRIGGERS; } })();
  return { enabled: r.enabled === true || r.enabled === 1, triggers: Array.isArray(triggers) ? triggers : DEFAULT_TRIGGERS, action: r.action || 'maintenance', hasToken: !!r.token, token: r.token || undefined, eventPath: '/agent-event' };
}

export async function saveOrchestratorConfig(tenantId: string, input: { enabled?: boolean; triggers?: unknown; action?: string }): Promise<OrchestratorConfigView> {
  const cur = await getOrchestratorConfig(tenantId);
  const enabled = input.enabled != null ? !!input.enabled : cur.enabled;
  const triggers = Array.isArray(input.triggers) ? input.triggers.map(String).slice(0, 10) : cur.triggers;
  const action = String(input.action || cur.action || 'maintenance').slice(0, 40);
  const token = cur.hasToken ? undefined : `agt_${randomBytes(20).toString('hex')}`;   // mint on first save
  await pool.query(
    `MERGE INTO api_orchestrator_config WITH (HOLDLOCK) AS t USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET enabled = $2, triggers = $3, action = $4, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, enabled, triggers, action, token) VALUES ($1, $2, $3, $4, $5);`,
    [tenantId, enabled ? 1 : 0, JSON.stringify(triggers), action, token || `agt_${randomBytes(20).toString('hex')}`],
  );
  return getOrchestratorConfig(tenantId);
}

export async function rotateOrchestratorToken(tenantId: string): Promise<{ token: string }> {
  const token = `agt_${randomBytes(20).toString('hex')}`;
  const cur = await getOrchestratorConfig(tenantId);
  await pool.query(
    `MERGE INTO api_orchestrator_config WITH (HOLDLOCK) AS t USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET token = $2, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, enabled, triggers, action, token) VALUES ($1, 0, $3, $4, $2);`,
    [tenantId, token, JSON.stringify(cur.triggers), cur.action],
  );
  return { token };
}

export async function resolveOrchestratorToken(token: string): Promise<string | null> {
  if (!token || !/^agt_[a-f0-9]{40}$/.test(token)) return null;
  const { rows } = await pool.query(`SELECT tenant_id FROM api_orchestrator_config WHERE token = $1`, [token]);
  return rows.length ? String(rows[0].tenant_id) : null;
}

export interface OrchestratorEvent { id: string; source: string; type: string; summary: string; status: string; createdAt: string }
function mapEvent(r: any): OrchestratorEvent {
  return { id: String(r.id), source: r.source || '', type: r.type || '', summary: r.summary || '', status: r.status || 'recorded', createdAt: r.created_at };
}

export async function listOrchestratorEvents(tenantId: string, limit = 50): Promise<OrchestratorEvent[]> {
  const { rows } = await pool.query(`SELECT TOP (${Math.min(200, Math.max(1, limit))}) * FROM api_orchestrator_events WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(mapEvent);
}

/** Classify a raw webhook body into a normalized {source, type, summary}. */
function classifyEvent(body: any): { source: string; type: string; summary: string } {
  if (body && (body.pull_request || body.action)) {
    const pr = body.pull_request;
    if (pr) return { source: 'github', type: 'pull_request', summary: `PR #${pr.number || '?'} ${body.action || ''}: ${String(pr.title || '').slice(0, 160)}` };
  }
  const t = String(body?.type || body?.event || body?.webhookEvent || '').toLowerCase();
  if (t.includes('sprint')) return { source: 'jira', type: 'sprint_started', summary: `Sprint event: ${String(body?.sprint?.name || body?.name || '').slice(0, 160)}` };
  return { source: String(body?.source || 'webhook').slice(0, 40), type: (t || 'event').slice(0, 60), summary: JSON.stringify(body || {}).slice(0, 200) };
}

export async function ingestEvent(token: string, body: any): Promise<{ received: boolean; triggered: boolean }> {
  const tenantId = await resolveOrchestratorToken(token);
  if (!tenantId) return { received: false, triggered: false };
  const cfg = await getOrchestratorConfig(tenantId);
  const ev = classifyEvent(body);
  const triggered = cfg.enabled && cfg.triggers.includes(ev.type);
  await pool.query(
    `INSERT INTO api_orchestrator_events (tenant_id, source, type, summary, status) VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, ev.source, ev.type, ev.summary, triggered ? `suggested:${cfg.action}` : 'recorded'],
  );
  // Capture-and-surface: when a matching trigger fires we flag a suggested action for the
  // UI to act on — we never launch a background pipeline run from an unauthenticated webhook.
  return { received: true, triggered };
}
