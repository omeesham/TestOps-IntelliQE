/**
 * api-azure-results.service.ts — Gap D: publish API run EXECUTION results to
 * Azure DevOps Test Runs, and render a JUnit document for a pipeline to publish.
 *
 * This is distinct from Azure DEFECT sync (api-azure-sync): that files bugs for
 * failures; this publishes the whole run's pass/fail outcomes as an ADO Test Run
 * so results live beside the work items. Reuses the existing Azure credentials
 * (azure-devops.service) — no new connection. A `dryRun` computes the payload and
 * outcome summary WITHOUT any Azure write, so the mapping is verifiable and a
 * real publish only happens on an explicit, authorized (admin) call.
 */
import axios from 'axios';
import { getCredsForTenant, type AdoCreds } from './azure-devops.service.js';
import { getApiRunDetail } from './api-dashboard.service.js';

const API_VERSION = '7.0';

type AdoOutcome = 'Passed' | 'Failed' | 'NotExecuted';
function toOutcome(status: string): AdoOutcome {
  if (status === 'passed') return 'Passed';
  if (status === 'failed' || status === 'broken') return 'Failed';
  return 'NotExecuted';
}

export interface PublishResultsInput { runId: string; dryRun?: boolean }
export interface PublishResultsResponse {
  dryRun: boolean;
  connected: boolean;
  runTitle: string;
  summary: { total: number; passed: number; failed: number; notExecuted: number };
  adoRunId?: number;
  webUrl?: string;
  published?: boolean;
}

function esc(s: string): string {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] || c));
}

interface RunCase { id: string; title: string; status: string; durationMs?: number; error?: string }

/** Render the run's cases as a JUnit <testsuites> document (CI-publishable). */
export function renderRunJUnit(runTitle: string, cases: RunCase[]): string {
  const failures = cases.filter((c) => toOutcome(c.status) === 'Failed').length;
  const skipped = cases.filter((c) => toOutcome(c.status) === 'NotExecuted').length;
  const totalTime = cases.reduce((n, c) => n + (c.durationMs || 0), 0) / 1000;
  const body = cases.map((c) => {
    const t = ((c.durationMs || 0) / 1000).toFixed(3);
    const oc = toOutcome(c.status);
    let inner = '';
    if (oc === 'Failed') inner = `<failure message="${esc(c.error || 'failed')}">${esc(c.error || '')}</failure>`;
    else if (oc === 'NotExecuted') inner = '<skipped/>';
    return `    <testcase name="${esc(c.title)}" classname="${esc(c.id)}" time="${t}">${inner}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${esc(runTitle)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${totalTime.toFixed(3)}">
  <testsuite name="${esc(runTitle)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${totalTime.toFixed(3)}">
${body}
  </testsuite>
</testsuites>`;
}

/** JUnit for a run — used by the pipeline-hook download endpoint. */
export async function runJUnit(tenantId: string, runId: string): Promise<{ xml: string; runTitle: string }> {
  const detail = await getApiRunDetail(tenantId, runId);
  if (!detail) throw new Error('Run not found.');
  const cases = (detail.cases || []).map((c) => ({ id: c.id, title: c.title, status: c.status, durationMs: c.durationMs, error: c.error }));
  return { xml: renderRunJUnit(detail.title || 'API run', cases), runTitle: detail.title || 'API run' };
}

/** Publish a run's outcomes to an Azure DevOps Test Run. dryRun ⇒ no Azure write. */
export async function publishRunResults(tenantId: string, input: PublishResultsInput): Promise<PublishResultsResponse> {
  const dryRun = input.dryRun === true;
  const detail = await getApiRunDetail(tenantId, input.runId);
  if (!detail) throw new Error('Run not found.');
  const cases: RunCase[] = (detail.cases || []).map((c) => ({ id: c.id, title: c.title, status: c.status, durationMs: c.durationMs, error: c.error }));
  const summary = {
    total: cases.length,
    passed: cases.filter((c) => toOutcome(c.status) === 'Passed').length,
    failed: cases.filter((c) => toOutcome(c.status) === 'Failed').length,
    notExecuted: cases.filter((c) => toOutcome(c.status) === 'NotExecuted').length,
  };

  let creds: AdoCreds | null = null;
  try { creds = await getCredsForTenant(tenantId); } catch { creds = null; }
  const connected = !!creds;
  const runTitle = detail.title || 'API run';

  if (dryRun) return { dryRun: true, connected, runTitle, summary };
  if (!creds) throw new Error('Azure DevOps is not connected. Connect it in System Configuration, or use a dry run to preview.');

  const headers = { Authorization: creds.authHeader, Accept: 'application/json' };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const base = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_apis/test`;

  // 1) create the run (automated, in progress)
  const created = await axios.post(
    `${base}/runs?api-version=${API_VERSION}`,
    { name: `IntelliQE API — ${runTitle} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, automated: true, state: 'InProgress' },
    { headers: jsonHeaders },
  );
  const adoRunId = created.data?.id as number;

  // 2) add results (chunked to stay within payload limits)
  const results = cases.map((c) => ({
    testCaseTitle: c.title.slice(0, 512),
    automatedTestName: c.id,
    outcome: toOutcome(c.status),
    state: 'Completed',
    durationInMs: Math.max(0, Math.round(c.durationMs || 0)),
    errorMessage: c.error ? String(c.error).slice(0, 1000) : undefined,
  }));
  for (let i = 0; i < results.length; i += 100) {
    await axios.post(`${base}/runs/${adoRunId}/results?api-version=${API_VERSION}`, results.slice(i, i + 100), { headers: jsonHeaders });
  }

  // 3) complete the run
  await axios.patch(`${base}/runs/${adoRunId}?api-version=${API_VERSION}`, { state: 'Completed' }, { headers: jsonHeaders });

  const webUrl = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_testManagement/runs?_a=resultSummary&runId=${adoRunId}`;
  return { dryRun: false, connected, runTitle, summary, adoRunId, webUrl, published: true };
}
