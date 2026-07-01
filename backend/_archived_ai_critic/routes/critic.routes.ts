/**
 * critic.routes — the AI Critic Agent's HTTP surface.
 *
 * POST /api/critic/run — review a run's TEST DESIGN + GENERATED SCRIPTS and return
 * a combined quality report. This backs the dedicated "AI Critic Agent" pipeline
 * stage in the wizard, which runs AFTER test design AND script generation so it
 * can critique BOTH:
 *   • test cases  → critiqueTestCases (deterministic structural + AI rubric +
 *                   deterministic coverage gate; the gate owns the verdict, L3).
 *   • scripts     → checkScriptQuality (pure deterministic Playwright-quality check).
 *
 * Stateless: it operates on exactly what the caller passes (parsedRequirements,
 * testCases, scripts), so there is no DB lossiness and it never mutates anything.
 *
 * SCOPE (L9): certifies test-DESIGN + script STRUCTURE statically. It does NOT run
 * the tests and does NOT prove runtime pass/fail — that stays executionAgent (real
 * Playwright) + healingAgent. It is a REVIEW stage: it reports gaps/violations and
 * a verdict, and does NOT regenerate (regeneration would orphan the just-generated
 * scripts; the design improvement loop belongs before script generation).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { critiqueTestCases } from '../agents/criticAgent.js';
import { checkScriptQuality, type ScriptInput } from '../agents/critic-script.js';
import type { CriticReport, ParsedRequirements, TestCase } from '../agents/state.js';

const router = Router();

type CombinedVerdict = 'approved' | 'needs_work' | 'rejected';
const RANK: Record<CombinedVerdict, number> = { approved: 0, needs_work: 1, rejected: 2 };

/** Overall verdict = the WORST of the design verdict and the script verdict. */
function scriptVerdict(ratio: number): CombinedVerdict {
  if (ratio >= 1) return 'approved';
  if (ratio < 0.5) return 'rejected';
  return 'needs_work';
}
function worst(a: CombinedVerdict, b: CombinedVerdict): CombinedVerdict {
  return RANK[a] >= RANK[b] ? a : b;
}

router.post('/run', async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const parsedRequirements = body.parsedRequirements as ParsedRequirements | null | undefined;
    const testCases: TestCase[] = Array.isArray(body.testCases) ? body.testCases : [];
    const scripts: ScriptInput[] = Array.isArray(body.scripts) ? body.scripts : [];

    // ── Script quality — pure deterministic, always available. ──
    const scriptReport = checkScriptQuality(scripts);

    // ── Test-design critique — one AI rubric call + deterministic gate. ──
    // Guarded: if the AI call fails the script review still returns.
    let design: CriticReport | null = null;
    if (parsedRequirements && testCases.length > 0) {
      try {
        design = await critiqueTestCases({ parsedRequirements, testCases });
      } catch (err) {
        console.error('[critic] design critique failed:', (err as Error)?.message);
        design = null;
      }
    }

    const designScore = design ? design.gate.computedOverall : 0;
    const scriptScore = scriptReport.score;

    // Combine ONLY the layers actually evaluated, so a design-only call isn't
    // dragged to 'rejected' by an (absent) empty script set, and vice-versa.
    const hasDesign = !!design;
    const hasScripts = scriptReport.totalScripts > 0;
    const designVerdict: CombinedVerdict = hasDesign ? (design!.gate.verdict as CombinedVerdict) : 'needs_work';
    const scVerdict = scriptVerdict(scriptReport.ratio);
    const verdict: CombinedVerdict =
      hasDesign && hasScripts ? worst(designVerdict, scVerdict)
        : hasDesign ? designVerdict
          : hasScripts ? scVerdict
            : 'needs_work';

    res.json({
      verdict,
      designScore,
      scriptScore,
      design,
      scripts: scriptReport,
    });
  } catch (err) {
    console.error('[critic] /run failed:', (err as Error)?.message);
    res.status(500).json({ error: 'Critic review failed', detail: (err as Error)?.message });
  }
});

export default router;
