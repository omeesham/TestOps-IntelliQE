import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { PlaywrightRunError } from '../services/playwright-runner.service.js';
import {
  recordRunScripts,
  readRecordingManifest,
  readFrameBundle,
  deleteRecordingEntry,
  isSafeSegment,
} from '../services/recording-runner.service.js';

const router = Router();

// Serialize record operations per run so concurrent full/subset records never
// race the manifest read-modify-write. Each caller still gets its own result.
const runChains = new Map<string, Promise<unknown>>();
function serializePerRun<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = (runChains.get(key) || Promise.resolve()).catch(() => {});
  const result = prev.then(fn);
  const tail = result.catch(() => {});
  runChains.set(key, tail);
  tail.finally(() => { if (runChains.get(key) === tail) runChains.delete(key); });
  return result;
}

/**
 * GET /api/recordings/runs  (auth required)
 * Recent test runs for this tenant, each flagged with whether a recording exists.
 */
router.get('/runs', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const recentRunsRes = user.isPlatform
      ? await pool.query(
          `SELECT tr.id, tr.story_key, tr.story_title, tr.source, tr.created_at,
                  (SELECT COUNT(*)::int FROM automation_scripts WHERE test_run_id = tr.id) AS script_count
           FROM test_runs tr ORDER BY tr.created_at DESC LIMIT 25`,
        )
      : await pool.query(
          `SELECT tr.id, tr.story_key, tr.story_title, tr.source, tr.created_at,
                  (SELECT COUNT(*)::int FROM automation_scripts WHERE test_run_id = tr.id) AS script_count
           FROM test_runs tr WHERE tr.tenant_id = $1
           ORDER BY tr.created_at DESC LIMIT 25`,
          [user.tenantId],
        );

    const runs = await Promise.all(
      recentRunsRes.rows.map(async (r: any) => {
        const manifest = await readRecordingManifest(user.tenantId, r.id);
        return {
          id: r.id,
          storyKey: r.story_key,
          storyTitle: r.story_title,
          source: r.source,
          createdAt: r.created_at,
          scriptCount: r.script_count,
          hasRecording: !!manifest,
          recordedAt: manifest?.recordedAt || null,
        };
      }),
    );

    res.json({ runs });
  } catch (err: any) {
    console.error('Recordings runs error:', err.message);
    res.status(500).json({ error: 'Failed to list runs for recordings' });
  }
});

/**
 * GET /api/recordings/by-run/:testRunId  (auth required)
 * The stored manifest for a run (per-test status, timing, poster + frame counts).
 * The heavy frame bundles are fetched lazily via /frames.
 */
router.get('/by-run/:testRunId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = String(req.params.testRunId);
    const manifest = await readRecordingManifest(user.tenantId, runId);
    if (!manifest) {
      res.json({ exists: false });
      return;
    }
    res.json({ exists: true, recording: manifest });
  } catch (err: any) {
    console.error('Recordings by-run error:', err.message);
    res.status(500).json({ error: 'Failed to load recording' });
  }
});

/**
 * GET /api/recordings/frames/:testRunId/:file  (auth required)
 * Return one test's frame bundle. tenantId is taken from the AUTHENTICATED user
 * (never the URL), so a request can only ever reach its own tenant's store —
 * there is no cross-tenant surface. runId + file are still strictly validated.
 */
router.get('/frames/:testRunId/:file', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = String(req.params.testRunId);
    const file = String(req.params.file);
    if (!isSafeSegment(runId) || !isSafeSegment(file)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const bundle = await readFrameBundle(user.tenantId, runId, file);
    if (!bundle) {
      res.status(404).json({ error: 'Recording frames not found' });
      return;
    }
    res.json(bundle);
  } catch (err: any) {
    console.error('Recordings frames error:', err.message);
    res.status(500).json({ error: 'Failed to load recording frames' });
  }
});

/**
 * POST /api/recordings/run/:testRunId  (auth required)
 * Execute the run's saved scripts with CDP screencast recording, then return the
 * manifest. Long-running — real browser execution.
 *
 * Body (optional): { only: string[] } — re-record just a subset of the run's
 * tests (each entry a test_case_id or tc_number), e.g. only the failed ones.
 * A subset record merges into the existing manifest, keeping the other tests.
 */
router.post('/run/:testRunId', async (req: Request, res: Response) => {
  const user = req.user!;
  const runId = String(req.params.testRunId);
  // Accept an optional subset selection; ignore anything that isn't a clean
  // array of non-empty strings, and cap it to a sane size.
  const only = Array.isArray(req.body?.only)
    ? req.body.only.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()).slice(0, 500)
    : undefined;
  const key = `${user.tenantId}:${runId}`;
  try {
    const manifest = await serializePerRun(key, () =>
      recordRunScripts(user.tenantId, user.isPlatform, runId, only),
    );
    res.json({ ok: true, recording: manifest });
  } catch (err: any) {
    if (err instanceof PlaywrightRunError) {
      res.status(err.httpStatus || 500).json(err.toResponseJson(true));
      return;
    }
    console.error('Recording run error:', err.message);
    res.status(500).json({ error: err.message || 'Recording failed' });
  }
});

/**
 * DELETE /api/recordings/:testRunId  (auth required)
 * Body: { id: string } — remove ONE test's recording from the run (its frame
 * bundle + manifest entry). tenantId is taken from the authenticated user, so a
 * caller can only ever delete within its own tenant. Deleting the last entry
 * removes the whole recording (exists:false in the response).
 */
router.delete('/:testRunId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = String(req.params.testRunId);
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    if (!isSafeSegment(runId)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'A test id is required to delete its recording' });
      return;
    }
    // Share the per-run lock with record ops so a delete never interleaves with
    // a record's manifest read-modify-write.
    const result = await serializePerRun(`${user.tenantId}:${runId}`, () =>
      deleteRecordingEntry(user.tenantId, runId, id),
    );
    res.json(result);
  } catch (err: any) {
    console.error('Recording delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete recording' });
  }
});

export default router;
