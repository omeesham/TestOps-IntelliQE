/**
 * api-impact.service.ts
 * ─────────────────────
 * History-/flow-aware change-impact analysis. The structural selector
 * (testintel's analyzeImpact) picks tests whose endpoint matches a changed one.
 * This widens that in two directions:
 *   - FLOW-AWARE: a multi-step saved flow that touches a changed endpoint is
 *     itself impacted, and so are the OTHER endpoints in that flow (a change
 *     upstream can break a later step), picked up transitively.
 *   - HISTORY-AWARE: each impacted endpoint is annotated with its recent
 *     failure rate so the selection can be ordered riskiest-first.
 *
 * Standalone and opt-in, read-only. REUSES analyzeImpact, the saved flows and
 * the dashboard run loaders; the pipeline is never involved.
 */
import { analyzeImpact, type ImpactResult } from './api-testintel.service.js';
import { requestSignature } from './api-coverage-gaps.service.js';
import { listFlows } from './api-flow.service.js';
import type { FlowStep } from './api-flow.service.js';
import { listApiRuns, resultsFor } from './api-dashboard.service.js';

export interface DeepImpactInput {
  changed: { method?: string; url: string }[];
  candidates: { id?: string; title?: string; method: string; url: string }[];
}

export interface ImpactedFlow { id: string; name: string; matchedSignatures: string[]; endpoints: { method: string; url: string; signature: string }[] }

export interface ImpactedEndpoint {
  id?: string;
  title?: string;
  method: string;
  url: string;
  signature: string;
  /** How it was selected. */
  via: ('structural' | 'flow')[];
  /** Names of flows that pull it in (when via includes 'flow'). */
  viaFlows: string[];
  failRate: number;
  appearances: number;
  priorityScore: number;
}

export interface DeepImpactResult {
  changedSignatures: string[];
  impacted: ImpactedEndpoint[];
  flows: ImpactedFlow[];
  structural: ImpactResult;
  summary: { candidates: number; structural: number; withFlows: number; total: number; selectedPct: number };
}

/** Flatten a flow's (possibly nested) request steps into {method,url}. */
function collectRequestSteps(steps: FlowStep[] | undefined, out: { method: string; url: string }[] = []): { method: string; url: string }[] {
  for (const s of steps || []) {
    if (!s) continue;
    const type = s.type || 'request';
    if (type === 'request' && s.url && /^https?:\/\//i.test(String(s.url))) {
      out.push({ method: String(s.method || 'GET').toUpperCase(), url: String(s.url) });
    }
    collectRequestSteps(s.then, out);
    collectRequestSteps(s.else, out);
    collectRequestSteps(s.steps, out);
  }
  return out;
}

export async function analyzeImpactDeep(tenantId: string, input: DeepImpactInput): Promise<DeepImpactResult> {
  const changed = (input.changed || []).filter((c) => c && c.url).map((c) => ({ method: c.method, url: String(c.url) }));
  const candidates = (input.candidates || []).filter((c) => c && /^https?:\/\//i.test(String(c.url || '')));

  // 1) Structural layer (reused verbatim).
  const structural = analyzeImpact({ changed, candidates });
  const changedSigs = new Set(structural.changedSignatures);
  const changedPaths = new Set([...changedSigs].map((s) => s.split(' ').slice(1).join(' ')));

  // 2) Flow layer — any saved flow that touches a changed signature, plus all its endpoints.
  const flows: ImpactedFlow[] = [];
  const flowPulledSigs = new Map<string, string[]>(); // signature → flow names that pull it in
  try {
    const saved = await listFlows(tenantId);
    for (const flow of saved) {
      const steps = collectRequestSteps(flow.steps);
      const stepSigs = steps.map((s) => ({ ...s, signature: requestSignature(s.method, s.url) }));
      const matched = stepSigs.filter((s) => changedSigs.has(s.signature) || changedPaths.has(s.signature.split(' ').slice(1).join(' ')));
      if (matched.length) {
        flows.push({ id: flow.id, name: flow.name, matchedSignatures: [...new Set(matched.map((m) => m.signature))], endpoints: stepSigs });
        for (const s of stepSigs) {
          const arr = flowPulledSigs.get(s.signature) || [];
          if (!arr.includes(flow.name)) arr.push(flow.name);
          flowPulledSigs.set(s.signature, arr);
        }
      }
    }
  } catch { /* flows are best-effort */ }

  // 3) History layer — fail rate per signature over recent runs.
  const history = await gatherHistory(tenantId, candidates);

  // 4) Merge structural + flow into a single ranked list.
  const impactedMap = new Map<string, ImpactedEndpoint>();
  const add = (c: { id?: string; title?: string; method: string; url: string }, via: 'structural' | 'flow', viaFlowNames: string[] = []) => {
    const sig = requestSignature(c.method, c.url);
    const existing = impactedMap.get(sig);
    const hist = history.get(sig) || { failed: 0, total: 0 };
    const failRate = hist.total ? Math.round((hist.failed / hist.total) * 100) : 0;
    if (existing) {
      if (!existing.via.includes(via)) existing.via.push(via);
      for (const n of viaFlowNames) if (!existing.viaFlows.includes(n)) existing.viaFlows.push(n);
      return;
    }
    const priorityScore = Math.min(100, failRate + (via === 'structural' ? 20 : 0) + (viaFlowNames.length ? 15 : 0));
    impactedMap.set(sig, { id: c.id, title: c.title, method: String(c.method || 'GET').toUpperCase(), url: c.url, signature: sig, via: [via], viaFlows: [...viaFlowNames], failRate, appearances: hist.total, priorityScore });
  };

  for (const e of structural.impacted) add(e, 'structural');
  // Flow-pulled endpoints: any candidate whose signature a matched flow includes.
  for (const c of candidates) {
    const sig = requestSignature(c.method, c.url);
    const flowNames = flowPulledSigs.get(sig);
    if (flowNames && flowNames.length) add(c, 'flow', flowNames);
  }

  const impacted = [...impactedMap.values()].sort((a, b) => b.priorityScore - a.priorityScore || b.failRate - a.failRate);
  const withFlows = impacted.filter((i) => i.via.includes('flow')).length;

  return {
    changedSignatures: [...changedSigs],
    impacted,
    flows,
    structural,
    summary: {
      candidates: candidates.length,
      structural: structural.impacted.length,
      withFlows,
      total: impacted.length,
      selectedPct: candidates.length ? Math.round((impacted.length / candidates.length) * 100) : 0,
    },
  };
}

/** Fail/total per request signature across recent runs, matched by path fragment. */
async function gatherHistory(tenantId: string, candidates: { method: string; url: string }[]): Promise<Map<string, { failed: number; total: number }>> {
  const history = new Map<string, { failed: number; total: number }>();
  try {
    const sigByPathKey = new Map<string, string>();
    for (const e of candidates) {
      const key = pathKeyOf(e.url);
      if (key) sigByPathKey.set(key, requestSignature(String(e.method || 'GET').toUpperCase(), e.url));
    }
    const { items } = await listApiRuns(tenantId, 1, 15);
    for (const run of items) {
      let rows: { name: string; status: string }[] = [];
      try { rows = await resultsFor(tenantId, run.runId, (run as any).hasAllure); } catch { rows = []; }
      for (const r of rows) {
        const st = String(r.status || '').toLowerCase();
        if (!['passed', 'failed', 'broken', 'ok', 'success'].includes(st)) continue;
        const name = String(r.name || '').toLowerCase();
        for (const [key, sig] of sigByPathKey) {
          if (key.length >= 3 && name.includes(key)) {
            const cur = history.get(sig) || { failed: 0, total: 0 };
            cur.total += 1;
            if (st === 'failed' || st === 'broken') cur.failed += 1;
            history.set(sig, cur);
            break;
          }
        }
      }
    }
  } catch { /* best-effort */ }
  return history;
}

function pathKeyOf(url: string): string {
  try { return new URL(url).pathname.toLowerCase().replace(/\/+$/, ''); }
  catch { return String(url || '').toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, ''); }
}
