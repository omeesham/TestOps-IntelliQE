/**
 * api-maintenance.service.ts
 * ──────────────────────────
 * Autonomous test maintenance. Scans the catalogue for drift (live contract vs
 * stored expectation) AND for endpoints that have real recorded traffic but no
 * test, then proposes a concrete, reviewable CHANGESET: adopt a new status,
 * adopt a new response shape, or add a missing endpoint. Qodex "agent keeps tests
 * current" parity — but a human reviews and applies.
 *
 * Standalone and opt-in: it REUSES the drift + coverage-gap services and REPORTS
 * proposals; application is client-side (ordinary catalogue edits / adds). The
 * generate → execute → heal pipeline is never touched. An LLM is used only,
 * optionally, to write a short plain-English summary of the changeset.
 */
import { scanDrift, type DriftEndpointInput } from './api-drift.service.js';
import { analyzeCoverageGaps } from './api-coverage-gaps.service.js';
import type { ImportedEndpoint } from './api-import.service.js';
import { runLLM, type LlmConfig } from '../agents/claude-runner.js';

export type ProposalKind = 'adopt-status' | 'adopt-response' | 'add-endpoint';

export interface MaintenanceProposal {
  id: string;
  kind: ProposalKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  method: string;
  url: string;
  rationale: string;
  /** adopt-*: the endpoint id in the catalogue to patch. */
  endpointId?: string;
  /** adopt-*: the catalogue patch to apply. */
  patch?: { expectedStatus?: number; expectedResponse?: string };
  /** add-endpoint: the endpoint to add to the catalogue. */
  addEndpoint?: ImportedEndpoint;
  /** add-endpoint: the traffic signature it came from. */
  signature?: string;
}

export interface MaintenancePlan {
  summary: { proposals: number; adoptStatus: number; adoptResponse: number; addEndpoint: number; drifted: number; gaps: number };
  proposals: MaintenanceProposal[];
  narrative?: string;
}

let seq = 0;
const pid = () => `mp-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export async function planMaintenance(
  tenantId: string,
  endpoints: DriftEndpointInput[],
  opts: { sessionId?: string; explain?: boolean; llm?: LlmConfig | null } = {},
): Promise<MaintenancePlan> {
  const proposals: MaintenanceProposal[] = [];

  // 1) Drift → adopt proposals.
  let drifted = 0;
  try {
    const drift = await scanDrift(endpoints);
    for (const r of drift.results) {
      if (r.statusDrift && r.suggestedStatus != null) {
        drifted++;
        proposals.push({
          id: pid(),
          kind: 'adopt-status',
          severity: 'high',
          title: `Expected status ${r.storedStatus ?? '—'} → ${r.suggestedStatus}`,
          method: r.method,
          url: r.url,
          rationale: `The live endpoint now returns ${r.suggestedStatus}; the catalogue still expects ${r.storedStatus ?? 'nothing'}. Adopting keeps generated tests asserting against today's contract.`,
          endpointId: r.id,
          patch: { expectedStatus: r.suggestedStatus },
        });
      }
      if (r.shapeDrift && r.suggestedResponse != null) {
        drifted++;
        const changed = r.changes.slice(0, 4).map((c) => `${c.kind} ${c.path}`).join(', ');
        proposals.push({
          id: pid(),
          kind: 'adopt-response',
          severity: r.changes.some((c) => c.kind === 'removed' || c.kind === 'type-changed') ? 'high' : 'medium',
          title: `Response shape drifted${changed ? ` (${changed})` : ''}`,
          method: r.method,
          url: r.url,
          rationale: `The response shape changed from what the catalogue stored${changed ? `: ${changed}` : ''}. Adopt the live sample so schema assertions match.`,
          endpointId: r.id,
          patch: { expectedResponse: r.suggestedResponse },
        });
      }
    }
  } catch (err) {
    // Drift needs reachable endpoints; a failure here must not sink the gap scan.
    console.warn('[maintenance] drift scan failed:', (err as Error).message);
  }

  // 2) Coverage gaps → add-endpoint proposals.
  let gaps = 0;
  try {
    const tested: ImportedEndpoint[] = endpoints.map((e) => ({
      title: e.title || `${e.method} ${e.url}`,
      method: e.method,
      url: e.url,
      headers: e.headers || [],
      auth: (e.auth as any) || { type: 'none' },
    }));
    const cov = await analyzeCoverageGaps(tenantId, tested, opts.sessionId);
    gaps = cov.gaps.length;
    for (let i = 0; i < cov.gaps.length; i++) {
      const g = cov.gaps[i]!;
      proposals.push({
        id: pid(),
        kind: 'add-endpoint',
        severity: 'medium',
        title: `Untested endpoint seen in traffic`,
        method: g.method,
        url: g.url,
        rationale: `Real recorded traffic hits ${cov.gapSignatures[i] || `${g.method} ${g.url}`} but there is no test for it. Add it to the catalogue and generate.`,
        addEndpoint: g,
        signature: cov.gapSignatures[i],
      });
    }
  } catch (err) {
    console.warn('[maintenance] coverage-gap scan failed:', (err as Error).message);
  }

  const summary = {
    proposals: proposals.length,
    adoptStatus: proposals.filter((p) => p.kind === 'adopt-status').length,
    adoptResponse: proposals.filter((p) => p.kind === 'adopt-response').length,
    addEndpoint: proposals.filter((p) => p.kind === 'add-endpoint').length,
    drifted,
    gaps,
  };

  let narrative: string | undefined;
  if (opts.explain && opts.llm && proposals.length) {
    try {
      const prompt = `You are a QA maintenance assistant. Summarise this proposed test-maintenance changeset in 2-3 sentences for a reviewer. Be concrete and non-alarmist.
Changeset:
${proposals.slice(0, 40).map((p) => `- [${p.kind}] ${p.method} ${p.url}: ${p.title}`).join('\n')}`;
      narrative = (await runLLM(prompt, { maxTokens: 400, llm: opts.llm })).trim().slice(0, 1200);
    } catch { /* narrative is optional */ }
  }

  return { summary, proposals, narrative };
}

/** A downloadable Markdown changeset from a plan (for a PR description / ticket). */
export function renderChangesetMarkdown(plan: MaintenancePlan): string {
  const lines: string[] = ['# API test maintenance changeset', ''];
  if (plan.narrative) lines.push(plan.narrative, '');
  lines.push(`**${plan.summary.proposals}** proposals — ${plan.summary.adoptStatus} status adoptions, ${plan.summary.adoptResponse} shape adoptions, ${plan.summary.addEndpoint} new endpoints.`, '');
  for (const p of plan.proposals) {
    lines.push(`## ${p.title}`, `- **Kind:** ${p.kind} (${p.severity})`, `- **Endpoint:** \`${p.method} ${p.url}\``, `- **Why:** ${p.rationale}`);
    if (p.patch?.expectedStatus != null) lines.push(`- **New expected status:** ${p.patch.expectedStatus}`);
    if (p.patch?.expectedResponse) lines.push(`- **New sample response:** truncated (${p.patch.expectedResponse.length} chars)`);
    lines.push('');
  }
  return lines.join('\n');
}
