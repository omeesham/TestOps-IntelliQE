import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import pool from '../db.js';
import {
  PlaywrightRunError,
  classifyPlaywrightFailureExternal,
} from './playwright-runner.service.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

// Playback tuning — keep recordings light. ~10fps cap and a hard frame ceiling
// so a long suite can't produce a multi-hundred-MB bundle.
const MIN_FRAME_GAP_MS = 100;
const MAX_FRAMES_PER_TEST = 600;

function sanitizeFileName(raw: string): string {
  return (raw || 'test').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

/**
 * Stable on-disk location where a run's execution RECORDINGS (per-test frame
 * bundles + manifest) are kept after a recorded run, so the Execution Recordings
 * page can replay the SAME execution without re-running anything. Keyed by
 * tenant + run.
 *
 * Recording is an additive, opt-in feature and never touches the core execution
 * path (executeRunScripts / Allure / reports stay untouched).
 */
export function storedRecordingsDir(tenantId: string, runId: string): string {
  return path.join(BACKEND_ROOT, 'recordings-store', tenantId, runId);
}

export interface RecordedTest {
  testCaseId: string | null;
  tcNumber: string | null;
  title: string;
  status: 'passed' | 'failed' | 'not_run';
  durationMs: number;
  /** Frame-bundle file name within the run's recordings dir, or null if none captured. */
  framesFile: string | null;
  /** Number of frames captured for this test. */
  frameCount: number;
  /** First frame as a base64 JPEG, for an instant poster without loading the bundle. */
  posterJpg: string | null;
  error?: string;
}

export interface RecordingManifest {
  runId: string;
  recordedAt: string;
  /** How the recording was captured. 'frames' = CDP screencast (no ffmpeg needed). */
  mode: 'frames';
  /** Wall-clock time of the whole Playwright run, in ms. */
  totalDurationMs: number;
  /** Sum of the individual test durations, in ms (sequential here, but kept explicit). */
  sumTestDurationMs: number;
  passed: number;
  failed: number;
  total: number;
  tests: RecordedTest[];
  /** True when no test produced any frames (capture unsupported on this host/browser). */
  captureUnavailable?: boolean;
  /** Human-readable note explaining a degraded recording. */
  note?: string;
}

/**
 * A frame bundle as persisted per test and served to the player.
 * `frames[i].tMs` is the playback offset from recording start; `jpg` is base64.
 */
export interface FrameBundle {
  durationMs: number;
  frames: { tMs: number; jpg: string }[];
}

/**
 * Auto-fixture shim. We rewrite each generated spec's `@playwright/test` import
 * to point here, so EVERY test transparently gets a CDP screencast attached to
 * its page — no spec edits, no ffmpeg. Frames are written to the test's output
 * dir and attached so the JSON reporter exposes their path (same harvest pattern
 * the old video path used). Capture is fully best-effort: any CDP error is
 * swallowed so it can never fail or alter the test result.
 */
const RECORDER_SHIM = `import { test as base } from '@playwright/test';
import fs from 'fs';

export * from '@playwright/test';

export const test = base.extend({
  __recorder: [async ({ page }, use, testInfo) => {
    let client;
    const frames = [];
    // Wall-clock window of the test BODY, so playback lasts as long as the test
    // actually ran (the last frame is held through any static/wait periods) —
    // not just the span of visual changes (which would play back as a quick flash).
    let recStart = Date.now();
    try {
      client = await page.context().newCDPSession(page);
      client.on('Page.screencastFrame', async (e) => {
        frames.push({ t: Date.now(), d: e.data });
        try { await client.send('Page.screencastFrameAck', { sessionId: e.sessionId }); } catch {}
      });
      await client.send('Page.startScreencast', {
        format: 'jpeg', quality: 50, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
      });
      recStart = Date.now();
    } catch {
      // CDP unavailable (non-Chromium) — recording is best-effort.
    }
    await use();
    const recEnd = Date.now();
    try { if (client) await client.send('Page.stopScreencast'); } catch {}
    if (frames.length) {
      try {
        const file = testInfo.outputPath('recorder-frames.json');
        fs.writeFileSync(file, JSON.stringify({ recStart, recEnd, frames }));
        await testInfo.attach('recorder-frames', { path: file, contentType: 'application/json' });
      } catch {}
    }
  }, { auto: true }],
});
`;

/** Point a spec's Playwright import at the recorder shim, without other edits. */
function injectRecorderImport(code: string): string {
  return code.replace(/from\s*['"]@playwright\/test['"]/g, "from './_recorder'");
}

/**
 * Throttle + normalize a recorder dump into a playback bundle.
 *
 * Accepts the current shape `{ recStart, recEnd, frames:[{t:msEpoch, d}] }`
 * (preferred — playback spans the real test-body window) and, for backward
 * compatibility, the legacy bare array `[{t:cdpSeconds, d}]` (spans only the
 * captured frames). `durationMs` is the real window when available so a test
 * plays back over the time it actually took, not as a quick flash.
 */
export function buildFrameBundle(
  input: { recStart?: number; recEnd?: number; frames?: { t: number; d: string }[] } | { t: number; d: string }[],
): FrameBundle {
  const hasWindow =
    !Array.isArray(input) && typeof input?.recStart === 'number' && Array.isArray(input?.frames);
  const rawFrames: { t: number; d: string }[] = Array.isArray(input)
    ? input
    : Array.isArray(input?.frames) ? input!.frames! : [];
  if (!rawFrames.length) return { durationMs: 0, frames: [] };

  // Normalize every timestamp to absolute ms. New dumps already use ms epoch;
  // legacy dumps use CDP seconds.
  const toMs = (t: number) => (hasWindow ? t : t * 1000);
  const originMs = hasWindow ? (input as any).recStart : toMs(rawFrames[0].t);

  let lastKept = -Infinity;
  const kept: { tMs: number; jpg: string }[] = [];
  for (const f of rawFrames) {
    const tMs = Math.max(0, Math.round(toMs(f.t) - originMs));
    if (kept.length && tMs - lastKept < MIN_FRAME_GAP_MS) continue;
    lastKept = tMs;
    kept.push({ tMs, jpg: f.d });
  }
  // Hard ceiling — downsample evenly if a very long test overflowed.
  let frames = kept;
  if (kept.length > MAX_FRAMES_PER_TEST) {
    const step = Math.ceil(kept.length / MAX_FRAMES_PER_TEST);
    frames = kept.filter((_, i) => i % step === 0);
  }
  const lastFrameMs = frames.length ? frames[frames.length - 1].tMs : 0;
  const windowMs = hasWindow ? Math.max(0, Math.round((input as any).recEnd - (input as any).recStart)) : lastFrameMs;
  return { durationMs: Math.max(windowMs, lastFrameMs), frames };
}

/** Stable identity for a test across runs (UUID preferred, then tc number, then title). */
function testKey(t: { testCaseId: string | null; tcNumber: string | null; title: string }): string {
  return (t.testCaseId || t.tcNumber || t.title || '').toLowerCase();
}

/**
 * Merge a freshly-recorded subset into a prior manifest's tests: replace the
 * entries that were just re-recorded (matched by stable identity), keep the rest,
 * and return them ordered by tc number for a stable display.
 *
 * If a re-recorded test captured NO frames this time but had a playable recording
 * before (e.g. a transient CDP hiccup), we keep the prior frames rather than
 * silently dropping a good recording — the new run's status/timing still win.
 */
export function mergeRecordedTests(existing: RecordedTest[], recorded: RecordedTest[]): RecordedTest[] {
  const prevByKey = new Map((existing || []).map((t) => [testKey(t), t]));
  const recordedKeys = new Set(recorded.map(testKey));
  const reconciled = recorded.map((t) => {
    if (!t.framesFile) {
      const prev = prevByKey.get(testKey(t));
      if (prev?.framesFile) {
        return { ...t, framesFile: prev.framesFile, frameCount: prev.frameCount, posterJpg: prev.posterJpg };
      }
    }
    return t;
  });
  const kept = (existing || []).filter((t) => !recordedKeys.has(testKey(t)));
  return [...kept, ...reconciled].sort((a, b) =>
    (a.tcNumber || a.title || '').localeCompare(b.tcNumber || b.title || '', undefined, { numeric: true }),
  );
}

/**
 * Execute a run's saved Playwright scripts with CDP SCREENCAST recording and
 * persist one frame bundle per test plus a manifest with timing data.
 *
 * Mirrors executeRunScripts (same spec-writing + JSON-summary parsing) but adds
 * the recorder shim. Uses CDP screencast instead of Playwright's video so it
 * needs NO ffmpeg (which corporate endpoint security commonly blocks). The core
 * executeRunScripts / Allure paths are left completely untouched.
 */
export async function recordRunScripts(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
  only?: string[],
): Promise<RecordingManifest> {
  if (!runId) throw new Error('runId is required to record Playwright tests');

  // `only` lets the caller re-record just a SUBSET of a run's tests (e.g. only the
  // failed ones, or only the passed ones). Each entry is a test_case_id (UUID) or
  // a tc_number. When present we record just those and MERGE into the existing
  // manifest, keeping the recordings for the tests we didn't re-run.
  const subsetIds = Array.isArray(only) ? only.filter((s) => typeof s === 'string' && s.trim()) : [];
  const isSubset = subsetIds.length > 0;

  const params: any[] = isPlatform ? [runId] : [runId, tenantId];
  let sql = `SELECT id, tc_number, test_case_id, test_case_title, file_name, code
       FROM "JBSTestOpsAI".automation_scripts
       WHERE test_run_id = $1 ${isPlatform ? '' : 'AND tenant_id = $2'}
       AND framework = 'playwright' AND code IS NOT NULL AND code <> ''`;
  if (isSubset) {
    const ph = subsetIds.map((_, i) => `$${params.length + i + 1}`).join(', ');
    // CAST guards against the UUID-conversion error when a tc_number string is
    // compared to the uniqueidentifier test_case_id column.
    sql += ` AND (CAST(test_case_id AS NVARCHAR(50)) IN (${ph}) OR tc_number IN (${ph}))`;
    params.push(...subsetIds);
  }
  const { rows } = await pool.query(sql, params);
  if (rows.length === 0) {
    throw new PlaywrightRunError({
      code: 'NO_SCRIPTS', httpStatus: 404,
      message: isSubset
        ? 'None of the selected tests have automation scripts to record.'
        : 'No automation scripts have been generated for this run yet.',
      hint: 'Generate scripts for this run before recording an execution.',
    });
  }

  const workspace = path.join(os.tmpdir(), `jbs-pwrec-${runId}-${Date.now()}`);
  const testsDir = path.join(workspace, 'tests');
  const outputDir = path.join(workspace, 'test-results');
  await fs.mkdir(testsDir, { recursive: true });

  // Recorder shim that every spec's import is redirected to.
  await fs.writeFile(path.join(testsDir, '_recorder.ts'), RECORDER_SHIM, 'utf-8');

  // Write each spec (no BOM), redirecting its Playwright import to the shim, and
  // map its final file name → DB row (for nice titles).
  const byFile = new Map<string, any>();
  const seen = new Set<string>();
  for (const row of rows) {
    let base = sanitizeFileName(row.file_name || row.tc_number || row.test_case_id || row.id);
    if (!base.endsWith('.spec.ts')) base = `${base}.spec.ts`;
    let candidate = base;
    let n = 1;
    while (seen.has(candidate)) candidate = base.replace(/\.spec\.ts$/, `-${++n}.spec.ts`);
    seen.add(candidate);
    await fs.writeFile(path.join(testsDir, candidate), injectRecorderImport(row.code), 'utf-8');
    byFile.set(candidate.toLowerCase().replace(/\.spec\.ts$/, ''), row);
  }

  // Single worker so the screencast captures one execution at a time cleanly
  // (more watchable than a parallel scramble). Only affects the recording run.
  const configPath = path.join(workspace, 'playwright.config.cjs');
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge';
  await fs.writeFile(configPath, `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: ${JSON.stringify(outputDir)},
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['line'], ['json', { outputFile: './pw-summary.json' }]],
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'edge', use: { channel: '${channel}' } }],
});
`, 'utf-8');

  const env = {
    ...process.env, CI: '1',
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(workspace, 'pw-summary.json'),
    NODE_PATH: path.join(BACKEND_ROOT, 'node_modules'),
  };
  const isWindows = process.platform === 'win32';
  let stdout = '', stderr = '';
  const startedAt = Date.now();
  try {
    const r = await execFileAsync(isWindows ? 'npx.cmd' : 'npx',
      ['playwright', 'test', '--config', configPath],
      { cwd: BACKEND_ROOT, env, timeout: 900_000, maxBuffer: 50 * 1024 * 1024, shell: isWindows });
    stdout = r.stdout; stderr = r.stderr;
  } catch (err: any) {
    stdout = err.stdout || ''; stderr = err.stderr || err.message || '';
  }
  const totalDurationMs = Date.now() - startedAt;

  let summary: any = null;
  try {
    summary = JSON.parse(await fs.readFile(path.join(workspace, 'pw-summary.json'), 'utf-8'));
  } catch { summary = null; }
  if (!summary) {
    const logPath = path.join(workspace, 'pw-run.log');
    await fs.writeFile(logPath, `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`, 'utf-8').catch(() => {});
    throw classifyPlaywrightFailureExternal(stdout, stderr, logPath);
  }

  // Flatten suites → specs → tests, attributing each back to its DB row by file.
  const specs: any[] = [];
  const walk = (s: any) => {
    if (Array.isArray(s?.specs)) specs.push(...s.specs);
    if (Array.isArray(s?.suites)) s.suites.forEach(walk);
  };
  (summary.suites || []).forEach(walk);
  const baseName = (f: string) => (f || '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.spec\.ts$/, '');

  // Destination dir. A FULL run starts fresh; a SUBSET run keeps existing
  // bundles and overwrites only the re-recorded tests, so we never wipe here.
  const dest = storedRecordingsDir(tenantId, runId);
  if (!isSubset) await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dest, { recursive: true });

  const usedNames = new Set<string>();
  const tests: RecordedTest[] = [];
  for (const spec of specs) {
    const result = spec?.tests?.[0]?.results?.[0];
    const st: string | undefined = result?.status;
    const passed = st === 'passed' || st === 'expected';
    const row = byFile.get(baseName(spec?.file || ''));
    const tcNumber: string | null = row?.tc_number || null;
    const testCaseId: string | null = row?.test_case_id || null;
    const title: string = spec?.title || row?.test_case_title || 'Untitled test';

    // Harvest the CDP frame bundle this test attached.
    const att = (result?.attachments || []).find(
      (a: any) => a?.name === 'recorder-frames' && a?.path,
    );
    let framesFile: string | null = null;
    let frameCount = 0;
    let posterJpg: string | null = null;
    if (att?.path) {
      try {
        const rawJson = JSON.parse(await fs.readFile(att.path, 'utf-8'));
        const bundle = buildFrameBundle(rawJson);
        if (bundle.frames.length) {
          // Deterministic name keyed by the test identity → a re-record overwrites
          // the same file rather than orphaning the old one.
          let name = `frames-${sanitizeFileName(testCaseId || tcNumber || title)}.frames.json`;
          let n = 1;
          while (usedNames.has(name)) name = `frames-${sanitizeFileName(testCaseId || tcNumber || title)}-${++n}.frames.json`;
          usedNames.add(name);
          framesFile = name;
          await fs.writeFile(path.join(dest, framesFile), JSON.stringify(bundle), 'utf-8');
          frameCount = bundle.frames.length;
          posterJpg = bundle.frames[0].jpg;
        }
      } catch (e: any) {
        console.warn('[recording-runner] failed to process frames:', e?.message);
      }
    }

    tests.push({
      testCaseId,
      tcNumber,
      title,
      status: passed ? 'passed' : st ? 'failed' : 'not_run',
      durationMs: typeof result?.duration === 'number' ? result.duration : 0,
      framesFile,
      frameCount,
      posterJpg,
      error: passed ? undefined : result?.error?.message || undefined,
    });
  }

  // For a subset run, merge the freshly recorded tests into the prior manifest,
  // keeping the recordings for tests we didn't re-run.
  let finalTests = tests;
  let priorTotalMs = 0;
  if (isSubset) {
    const existing = await readRecordingManifest(tenantId, runId);
    if (existing) {
      finalTests = mergeRecordedTests(existing.tests, tests);
      priorTotalMs = existing.totalDurationMs || 0;
    }
  }

  const sumTestDurationMs = finalTests.reduce((sum, t) => sum + (t.durationMs || 0), 0);
  // Keep the run-level total consistent with the merged set: it must never be
  // less than the sum of test durations, nor shrink below the prior recording
  // when only a subset was re-run (which only times the subset's wall clock).
  const manifestTotalDurationMs = Math.max(totalDurationMs, sumTestDurationMs, priorTotalMs);

  // Reflect the FINAL merged set (a subset re-run that itself captured nothing
  // must not flag a recording whose kept tests still have frames).
  const captureUnavailable = finalTests.length > 0 && !finalTests.some((t) => (t.frameCount || 0) > 0);
  const manifest: RecordingManifest = {
    runId,
    recordedAt: new Date().toISOString(),
    mode: 'frames',
    totalDurationMs: manifestTotalDurationMs,
    sumTestDurationMs,
    passed: finalTests.filter((t) => t.status === 'passed').length,
    failed: finalTests.filter((t) => t.status === 'failed').length,
    total: finalTests.length,
    tests: finalTests,
    ...(captureUnavailable
      ? {
          captureUnavailable: true,
          note:
            'Test timing and results were captured, but no screen frames were recorded. ' +
            'Screen capture uses the Chromium DevTools Protocol and needs a Chromium-based browser ' +
            '(Edge/Chrome). Confirm PLAYWRIGHT_CHANNEL points to msedge/chrome on the runner host.',
        }
      : {}),
  };

  await fs.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  // Best-effort cleanup of the temp workspace — bundles we keep are already in the store.
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});

  return manifest;
}

/**
 * Read a previously recorded run's manifest from the stable store. Returns null
 * when no recording exists yet for this tenant + run.
 */
export async function readRecordingManifest(
  tenantId: string,
  runId: string,
): Promise<RecordingManifest | null> {
  try {
    const raw = await fs.readFile(path.join(storedRecordingsDir(tenantId, runId), 'manifest.json'), 'utf-8');
    return JSON.parse(raw) as RecordingManifest;
  } catch {
    return null;
  }
}

/**
 * Read a single test's frame bundle from the store, with strict validation of
 * the file name (no path separators / traversal). Returns null if absent.
 */
export async function readFrameBundle(
  tenantId: string,
  runId: string,
  framesFile: string,
): Promise<FrameBundle | null> {
  if (!isSafeSegment(framesFile) || !framesFile.endsWith('.frames.json')) return null;
  const dir = storedRecordingsDir(tenantId, runId);
  const target = path.resolve(dir, framesFile);
  // Defense in depth: the resolved path must stay strictly inside `dir`.
  const rel = path.relative(dir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return JSON.parse(await fs.readFile(target, 'utf-8')) as FrameBundle;
  } catch {
    return null;
  }
}

/**
 * Delete a single test's recording from a run: remove its frame bundle file and
 * its manifest entry, recompute aggregates, and persist. If it was the last
 * entry, the whole recording (dir) is removed. `identifier` is the test's stable
 * key (testCaseId, tcNumber, or title) as the UI holds it.
 *
 * Returns `exists:false` when no recording remains for the run afterwards.
 */
export async function deleteRecordingEntry(
  tenantId: string,
  runId: string,
  identifier: string,
): Promise<{ deleted: boolean; exists: boolean; recording: RecordingManifest | null }> {
  const manifest = await readRecordingManifest(tenantId, runId);
  if (!manifest) return { deleted: false, exists: false, recording: null };

  const wantKey = (identifier || '').toLowerCase();
  const idx = manifest.tests.findIndex((t) => testKey(t) === wantKey);
  if (idx === -1) return { deleted: false, exists: true, recording: manifest };

  const dir = storedRecordingsDir(tenantId, runId);
  const [removed] = manifest.tests.splice(idx, 1);

  // Best-effort delete of the frame bundle file — validated to stay inside `dir`
  // and to be a frames bundle, so we can never rm anything else.
  if (removed?.framesFile && isSafeSegment(removed.framesFile) && removed.framesFile.endsWith('.frames.json')) {
    const target = path.resolve(dir, removed.framesFile);
    const rel = path.relative(dir, target);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      await fs.rm(target, { force: true }).catch(() => {});
    }
  }

  // Nothing left → drop the whole recording.
  if (manifest.tests.length === 0) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { deleted: true, exists: false, recording: null };
  }

  const sumTestDurationMs = manifest.tests.reduce((s, t) => s + (t.durationMs || 0), 0);
  const captureUnavailable = !manifest.tests.some((t) => (t.frameCount || 0) > 0);
  const updated: RecordingManifest = {
    runId: manifest.runId,
    recordedAt: manifest.recordedAt,
    mode: 'frames',
    totalDurationMs: Math.max(manifest.totalDurationMs || 0, sumTestDurationMs),
    sumTestDurationMs,
    passed: manifest.tests.filter((t) => t.status === 'passed').length,
    failed: manifest.tests.filter((t) => t.status === 'failed').length,
    total: manifest.tests.length,
    tests: manifest.tests,
    ...(captureUnavailable ? { captureUnavailable: true, note: manifest.note } : {}),
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(updated, null, 2), 'utf-8');
  return { deleted: true, exists: true, recording: updated };
}

/** A single path segment with no separators, no traversal, no funny business. */
export function isSafeSegment(s: string): boolean {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 200 &&
    !s.includes('/') &&
    !s.includes('\\') &&
    !s.includes('\0') &&
    s !== '.' &&
    s !== '..' &&
    path.basename(s) === s
  );
}
