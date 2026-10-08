/**
 * api-suite-optimizer.service.ts
 * ──────────────────────────────
 * Suite Optimizer — two jobs over the catalogue, both read-only:
 *   1. REDUNDANCY PRUNING — cluster endpoints that resolve to the same request
 *      signature (same verb + normalised path) so near-duplicate tests can be
 *      collapsed to one representative.
 *   2. RISK-BASED PRIORITISATION — score each endpoint from its recent failure
 *      history, flaky-quarantine status, how often it shows up in real recorded
 *      traffic (change/usage frequency), the risk of its HTTP verb, and whether
 *      it is auth-protected — then rank so the riskiest run first.
 *
 * Standalone and opt-in. It REUSES the dashboard run loaders, the quarantine
 * list, the capture sessions and `requestSignature`; the scoring itself is a
 * pure function so it is unit-testable. Nothing is mutated and the generate →
 * execute → heal pipeline is never involved.
 */
import { listApiRuns, resultsFor } from './api-dashboard.service.js';
import { requestSignature } from './api-coverage-gaps.service.js';
import { listCaptureSessions, captureToEndpoints } from './api-capture.service.js';
import { listQuarantine } from './api-testintel.service.js';

export interface OptimizerEndpoint { id?: string; title?: string; method: string; url: string; auth?: { type?: string } }

export interface PrioritizedEndpoint {
  id?: string;
  title?: string;
  method: string;
  url: string;
  signature: string;
  score: number;             // 0–100 composite risk
  priority: 'critical' | 'high' | 'medium' | 'low';
  reasons: string[];
  failRate: number;          // 0–100 across analysed runs
  appearances: number;       // times seen in analysed runs
  traffic: number;           // times the signature appears in recorded traffic
  quarantined: boolean;
}

export interface RedundancyCluster { signature: string; endpoints: { id?: string; title?: string; method: string; url: string }[] }

export interface SuiteOptimizerResult {
  runsAnalyzed: number;
  prioritized: PrioritizedEndpoint[];
  redundancies: RedundancyCluster[];
  summary: { endpoints: number; redundantGroups: number; prunable: number; critical: number; high: number };
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Signals gathered from history/traffic, keyed by request signature. */
export interface OptimizerSignals {
  /** signature → { failed, total } across analysed runs */
  history: Map<string, { failed: number; total: number }>;
  /** signature → times seen in recorded traffic */
  traffic: Map<string, number>;
  /** request signatures that are quarantined as flaky */
  quarantined: Set<string>;
  runsAnalyzed: number;
}

/** PURE: score + rank + cluster. Separated from IO so it can be unit-tested. */
export function buildOptimization(endpoints: OptimizerEndpoint[], signals: OptimizerSignals): SuiteOptimizerResult {
  const bySig = new Map<string, OptimizerEndpoint[]>();
  const prioritized: PrioritizedEndpoint[] = [];

  for (const e of endpoints) {
    const method = String(e.method || 'GET').toUpperCase();
    const sig = requestSignature(method, e.url);
    const group = bySig.get(sig) || [];
    group.push(e);
    bySig.set(sig, group);

    const hist = signals.history.get(sig) || { failed: 0, total: 0 };
    const failRate = hist.total ? Math.round((hist.failed / hist.total) * 100) : 0;
    const traffic = signals.traffic.get(sig) || 0;
    const quarantined = signals.quarantined.has(sig);
    const hasAuth = !!(e.auth && e.auth.type && e.auth.type !== 'none');

    // Composite 0–100. History dominates (a test that actually fails is the
    // clearest risk), then traffic (what users actually hit), then the
    // structural risks of the verb and of touching protected data.
    let score = 0;
    const reasons: string[] = [];
    if (hist.total > 0) {
      const histScore = Math.round(failRate * 0.5); // up to 50
      score += histScore;
      if (failRate > 0) reasons.push(`${failRate}% fail rate over ${hist.total} run${hist.total === 1 ? '' : 's'}`);
    }
    if (traffic > 0) {
      const t = Math.min(20, Math.round(Math.log2(traffic + 1) * 6)); // up to 20
      score += t;
      reasons.push(`seen ${traffic}× in real traffic`);
    }
    if (WRITE.has(method)) { score += 15; reasons.push(`${method} mutates state`); }
    if (hasAuth) { score += 10; reasons.push('auth-protected'); }
    if (quarantined) { score += 8; reasons.push('quarantined as flaky'); }
    score = Math.min(100, score);

    const priority: PrioritizedEndpoint['priority'] = score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low';

    prioritized.push({
      id: e.id, title: e.title, method, url: e.url, signature: sig,
      score, priority, reasons: reasons.length ? reasons : ['no risk signal — low priority'],
      failRate, appearances: hist.total, traffic, quarantined,
    });
  }

  prioritized.sort((a, b) => b.score - a.score || (WRITE.has(b.method) ? 1 : 0) - (WRITE.has(a.method) ? 1 : 0));

  const redundancies: RedundancyCluster[] = [];
  let prunable = 0;
  for (const [sig, group] of bySig) {
    if (group.length > 1) {
      redundancies.push({ signature: sig, endpoints: group.map((e) => ({ id: e.id, title: e.title, method: String(e.method || 'GET').toUpperCase(), url: e.url })) });
      prunable += group.length - 1; // keep one representative per cluster
    }
  }
  redundancies.sort((a, b) => b.endpoints.length - a.endpoints.length);

  return {
    runsAnalyzed: signals.runsAnalyzed,
    prioritized,
    redundancies,
    summary: {
      endpoints: endpoints.length,
      redundantGroups: redundancies.length,
      prunable,
      critical: prioritized.filter((p) => p.priority === 'critical').length,
      high: prioritized.filter((p) => p.priority === 'high').length,
    },
  };
}

/** Gather history + traffic + quarantine signals, then score. Read-only. */
export async function optimizeSuite(tenantId: string, endpoints: OptimizerEndpoint[], opts: { runLimit?: number } = {}): Promise<SuiteOptimizerResult> {
  // 1) Failure history → fails/total per signature, matched to endpoints by path.
  const history = new Map<string, { failed: number; total: number }>();
  let runsAnalyzed = 0;
  try {
    const { items } = await listApiRuns(tenantId, 1, Math.min(50, Math.max(2, opts.runLimit || 20)));
    runsAnalyzed = items.length;
    // Pre-index endpoints by a path fragment so a test name can be matched to one.
    const sigByPathKey = new Map<string, string>();
    for (const e of endpoints) {
      const key = pathKeyOf(e.url);
      if (key) sigByPathKey.set(key, requestSignature(String(e.method || 'GET').toUpperCase(), e.url));
    }
    for (const run of items) {
      let rows: { name: string; status: string }[] = [];
      try { rows = await resultsFor(tenantId, run.runId, (run as any).hasAllure); } catch { rows = []; }
      for (const r of rows) {
        const st = String(r.status || '').toLowerCase();
        if (st !== 'passed' && st !== 'failed' && st !== 'broken' && st !== 'ok' && st !== 'success') continue;
        const name = String(r.name || '').toLowerCase();
        for (const [key, sig] of sigByPathKey) {
          if (key.length >= 3 && name.includes(key)) {
            const cur = history.get(sig) || { failed: 0, total: 0 };
            cur.total += 1;
            if (st === 'failed' || st === 'broken') cur.failed += 1;
            history.set(sig, cur);
            break; // attribute to the first matching endpoint only
          }
        }
      }
    }
  } catch { /* history is best-effort; absence just means no history signal */ }

  // 2) Traffic frequency per signature from recorded capture sessions.
  const traffic = new Map<string, number>();
  try {
    const sessions = await listCaptureSessions(tenantId);
    for (const s of sessions.slice(0, 20)) {
      let eps: { method: string; url: string }[] = [];
      try { eps = (await captureToEndpoints(tenantId, s.id)).endpoints as any; } catch { eps = []; }
      for (const ep of eps) {
        const sig = requestSignature(String(ep.method || 'GET').toUpperCase(), ep.url);
        traffic.set(sig, (traffic.get(sig) || 0) + 1);
      }
    }
  } catch { /* traffic is best-effort */ }

  // 3) Quarantine → signatures.
  const quarantined = new Set<string>();
  try {
    const q = await listQuarantine(tenantId);
    for (const item of q) {
      // testKey is "METHOD url" by convention; derive a signature where possible.
      const parts = String(item.testKey || '').trim().split(/\s+/);
      if (parts.length >= 2) quarantined.add(requestSignature(parts[0]!, parts.slice(1).join(' ')));
      else quarantined.add(String(item.testKey || '').trim());
    }
  } catch { /* quarantine is best-effort */ }

  return buildOptimization(endpoints, { history, traffic, quarantined, runsAnalyzed });
}

/** A stable lowercase path fragment used to tie a test name back to an endpoint. */
function pathKeyOf(url: string): string {
  try { return new URL(url).pathname.toLowerCase().replace(/\/+$/, ''); }
  catch { return String(url || '').toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, ''); }
}
