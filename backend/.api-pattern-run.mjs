/**
 * API pattern validation runner (temporary harness — delete after the run).
 *
 * Drives the REAL IntelliQE API Automation pipeline for each endpoint in the
 * validation pack: apiGeneratorAgent → executionAgent → apiHealingAgent →
 * re-execute. Same agents, same deterministic renderer, same Playwright
 * executor the product calls; this only replaces the HTTP/auth layer so the
 * run does not need a login session.
 *
 * Usage:  node --env-file=.env .api-pattern-run.mjs <endpoints.json> <out.json> [fromIndex] [toIndex]
 *
 * Results stream to <out.json> after every endpoint, so an interrupted run
 * keeps everything it had already proved.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const [, , ENDPOINTS_FILE, OUT_FILE, FROM = '0', TO = '999'] = process.argv;
const TENANT = process.env.PATTERN_RUN_TENANT || '7879DEBC-088A-4657-8195-720F0E3A5C73';
const DEPTH = process.env.PATTERN_RUN_DEPTH || 'standard';

const { getTenantLlm } = await import('./dist/services/llm.service.js');
const { createInitialState } = await import('./dist/agents/state.js');
const { apiGeneratorAgent } = await import('./dist/agents/apiGeneratorAgent.js');
const { executionAgent } = await import('./dist/agents/executionAgent.js');
const { apiHealingAgent } = await import('./dist/agents/apiHealingAgent.js');

const llm = await getTenantLlm(TENANT);
if (!llm) { console.error('No LLM configured for this tenant.'); process.exit(1); }

const endpoints = JSON.parse(await fs.readFile(ENDPOINTS_FILE, 'utf-8'))
  .slice(Number(FROM), Number(TO));

/** "Accept: application/json\nX-Key: v" → [{key,value}] */
function parseHeaders(text) {
  if (!text) return [];
  return String(text)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return i === -1 ? null : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

const results = [];
const save = () => fs.writeFile(OUT_FILE, JSON.stringify(results, null, 2));

for (const ep of endpoints) {
  const started = Date.now();
  const row = {
    ref: ep.ref, pattern: ep.pattern, title: ep.title, method: ep.method, url: ep.url,
    generated: 0, passed: 0, failed: 0, notRun: 0, healed: 0,
    status: 'error', notes: '', failures: [], healNotes: [], durationMs: 0,
  };
  const log = (m) => console.log(`[${ep.ref}] ${m}`);

  try {
    let baseUrl;
    try { baseUrl = new URL(ep.url).origin; } catch { throw new Error(`Invalid URL: ${ep.url}`); }

    const apiSpec = {
      method: String(ep.method || 'GET').toUpperCase(),
      url: ep.url,
      baseUrl,
      headers: parseHeaders(ep.headers),
      auth: { type: ep.authType || 'none', value: ep.authValue || undefined },
      body: ep.body || undefined,
      expectedStatus: ep.expectedStatus ? Number(ep.expectedStatus) : undefined,
      expectedResponse: ep.expectedResponse || undefined,
      coverage: DEPTH,
    };

    // ── Stage 1: design the scenarios ──────────────────────────────────
    log(`generating (${DEPTH})…`);
    let state = {
      ...createInitialState('', { targetUrl: baseUrl, appName: 'API' }, llm),
      apiSpec,
    };
    state = await apiGeneratorAgent(state);
    row.generated = state.testCases.length;
    log(`${row.generated} scenarios, ${state.automationScripts.length} specs`);
    if (row.generated === 0) throw new Error('generator produced no scenarios');

    // ── Stage 2: execute ───────────────────────────────────────────────
    const allureDir = path.join(os.tmpdir(), `pv-allure-${ep.ref}-${Date.now()}`);
    const htmlDir = path.join(os.tmpdir(), `pv-html-${ep.ref}-${Date.now()}`);
    log('executing…');
    let exec = await executionAgent(state, { htmlReportDir: htmlDir, allureResultsDir: allureDir });

    if (exec.executionResults === null) {
      row.status = 'Blocked';
      row.notes = `Execution did not run: ${exec.failureReason || 'unknown'}`;
      row.notRun = row.generated;
    } else {
      let details = exec.executionResults.details || [];
      row.passed = exec.executionResults.passed || 0;
      row.failed = exec.executionResults.failed || 0;
      log(`${row.passed} passed, ${row.failed} failed`);

      // ── Stage 3: heal + re-execute, when anything failed ─────────────
      if (row.failed > 0) {
        log(`healing ${row.failed}…`);
        const failuresByTc = Object.fromEntries(
          details.filter((d) => d.status === 'failed').map((d) => [d.testCaseId, d.error || 'failed']));
        const marked = {
          ...exec,
          testCases: exec.testCases.map((tc) => (failuresByTc[tc.id] ? { ...tc, status: 'failed' } : tc)),
          failureReason: Object.values(failuresByTc)[0] || 'failed',
        };
        try {
          const healed = await apiHealingAgent(marked, { failuresByTc });
          const repaired = healed.automationScripts.filter((s, i) => s.code !== exec.automationScripts[i]?.code).length;
          row.healNotes = Object.entries(healed.healingNotes || {}).map(([id, note]) => ({ id, note }));

          if (repaired > 0) {
            log(`re-executing after ${repaired} repair(s)…`);
            await fs.rm(allureDir, { recursive: true, force: true }).catch(() => {});
            const re = await executionAgent({ ...healed, failureReason: null },
              { htmlReportDir: htmlDir, allureResultsDir: allureDir });
            if (re.executionResults) {
              const before = row.failed;
              details = re.executionResults.details || [];
              row.passed = re.executionResults.passed || 0;
              row.failed = re.executionResults.failed || 0;
              row.healed = Math.max(0, before - row.failed);
              log(`after heal: ${row.passed} passed, ${row.failed} failed (${row.healed} recovered)`);
            }
          } else {
            log('healer made no changes (all failures judged genuine)');
          }
        } catch (e) {
          row.notes = `Heal failed: ${e.message.slice(0, 200)}`;
        }
      }

      row.notRun = Math.max(0, row.generated - row.passed - row.failed);
      row.failures = details.filter((d) => d.status === 'failed').map((d) => ({
        id: d.testCaseId,
        scenario: (d.scenario || '').slice(0, 120),
        error: String(d.error || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' · ').slice(0, 300),
      }));
      row.status = row.failed === 0 && row.notRun === 0 ? 'Pass' : row.passed > 0 ? 'Partial' : 'Fail';
    }
    await fs.rm(allureDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(htmlDir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    row.status = 'Error';
    row.notes = String(err.message || err).slice(0, 400);
    log(`ERROR: ${row.notes}`);
  }

  row.durationMs = Date.now() - started;
  results.push(row);
  await save();
  console.log(`[${ep.ref}] ${row.status} — ${row.passed}/${row.generated} passed in ${(row.durationMs / 1000).toFixed(0)}s\n`);
}

console.log(`\nDONE — ${results.length} endpoints. Results in ${OUT_FILE}`);
process.exit(0);
