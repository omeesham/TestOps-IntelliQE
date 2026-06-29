/**
 * Heal engine — the single, shared algorithm behind every auto-heal in the
 * product (the DB-backed wizard service AND the in-memory pipeline agent both
 * call it, so heal QUALITY is identical no matter which path runs).
 *
 * Properties that make it production-grade:
 *  1. ITERATIVE with feedback — up to `maxRounds` attempts per test; each failed
 *     attempt's REAL re-run error (and the history of what was already tried) is
 *     fed back into the next attempt, so the model fixes the root cause instead
 *     of guessing the same wrong fix twice.
 *  2. ANTI-CHEAT — every candidate is statically checked (heal-guard) against the
 *     ORIGINAL spec; any fix that passes by WEAKENING the test (dropping/loosening
 *     assertions, test.skip, trivially-true expects, removing negative guards) is
 *     REJECTED even if it would pass at runtime. A green that destroys the test
 *     is never accepted.
 *  3. VERIFY-BEFORE-TRUST — a candidate is only considered healed after it is
 *     re-run in a throwaway workspace (via the injected `verify`) and actually
 *     passes. Nothing unverified is ever returned as "healed".
 *  4. CONVERGENCE + QUARANTINE — if the model repeats a prior fix, or attempts are
 *     exhausted, the test is quarantined for human review rather than blanket-
 *     retried or silently "passed".
 *  5. RETRY-RESILIENT PARSING — the fix call uses runClaudeJson, so a truncated or
 *     prose-wrapped reply is re-sampled instead of losing the fix.
 *  6. TELEMETRY — every attempt is recorded (diagnosis, fix, outcome, error) for
 *     heal-rate / flake metrics.
 */
import { runClaudeJson } from './claude-runner.js';
import { buildHealingPrompt, type HealingFix, type HealAttemptRecord } from './healing-prompt.js';
import { detectAssertionWeakening, isNoOpFix, categorizeFailure, type FailureCategory } from './heal-guard.js';

export interface HealSpecInput {
  /** Stable key for this test (the test_case_id). */
  id: string;
  fileName: string;
  /** Current (failing) spec source — also the weakening baseline. */
  code: string;
  intent: {
    title: string;
    feature?: string;
    type?: string;
    precondition?: string;
    steps?: string[];
    expectedResult?: string;
  };
  /** The real error from the original failing run. */
  initialError: string;
}

export interface HealOutcome {
  id: string;
  /** A verified-passing, non-weakening fix was produced and is safe to persist. */
  healed: boolean;
  /** Code to persist: the healed code when healed, otherwise the untouched original. */
  finalCode: string;
  finalStatus: 'passed' | 'failed';
  finalError?: string;
  durationMs?: number;
  category: FailureCategory;
  /** Attempts were exhausted (or did not converge) without a safe verified fix. */
  quarantined: boolean;
  attempts: HealAttemptRecord[];
  /** Human-readable, honest description of what happened. */
  summary: string;
}

export type VerifyFn = (
  specs: { key: string; fileName: string; code: string }[],
) => Promise<Map<string, { status: 'passed' | 'failed' | 'flaky' | 'not_run'; durationMs?: number; error?: string }>>;

export interface HealEngineOptions {
  canUseAi: boolean;
  targetUrl?: string;
  /** Max heal rounds per test (default 3; env HEAL_MAX_ATTEMPTS overrides). */
  maxRounds?: number;
}

interface HealState {
  input: HealSpecInput;
  currentCode: string;
  lastError: string;
  history: HealAttemptRecord[];
  triedCodes: Set<string>;
  done: boolean;
  healed: boolean;
  finalCode: string;
  finalStatus: 'passed' | 'failed';
  finalError?: string;
  durationMs?: number;
  quarantined: boolean;
}

function resolveMaxRounds(opt?: number): number {
  const envRaw = Number(process.env.HEAL_MAX_ATTEMPTS);
  const fromEnv = Number.isFinite(envRaw) && envRaw > 0 ? Math.floor(envRaw) : undefined;
  // Clamp to a sane ceiling so a stray env value can't spin the loop (and the
  // cost) unbounded.
  return Math.min(5, Math.max(1, opt ?? fromEnv ?? 3));
}

/** Max concurrent AI fix calls per round — bounds rate-limit/cost blowup when a
 *  run has many failing tests. Tunable via HEAL_CONCURRENCY. */
const AI_CONCURRENCY = Math.max(1, Number(process.env.HEAL_CONCURRENCY) || 4);

/** Run `fn` over `items` with a fixed concurrency limit, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildSummary(st: HealState): string {
  if (st.healed) {
    const pass = [...st.history].reverse().find((h) => h.outcome === 'passed');
    const base = pass && (pass.diagnosis || pass.fix)
      ? [pass.diagnosis, pass.fix].filter(Boolean).join(' → ')
      : 'Applied a verified fix.';
    const n = st.history.length;
    return n > 1 ? `${base} (verified after ${n} attempt(s))` : base;
  }
  if (st.history.some((h) => h.outcome === 'rejected-weakening')) {
    return 'Could not auto-heal without weakening the test (the only fixes offered deleted or loosened the assertion) — quarantined for human review.';
  }
  if (st.history.some((h) => h.outcome === 'stuck')) {
    return 'Auto-heal did not converge (the model repeated a fix that already failed) — quarantined for human review.';
  }
  if (st.history.length > 0 && st.history.every((h) => h.outcome === 'ai-error')) {
    return 'The AI did not return a usable fix — quarantined for human review.';
  }
  return `Could not auto-heal after ${st.history.length} attempt(s) — quarantined for human review.`;
}

/**
 * Heal a batch of failing specs. Returns one HealOutcome per input id. Re-runs
 * are BATCHED per round (one Playwright invocation for all still-failing specs),
 * so N tests over R rounds cost at most R Playwright runs, not N×R.
 */
export async function healSpecs(
  inputs: HealSpecInput[],
  verify: VerifyFn,
  opts: HealEngineOptions,
): Promise<Map<string, HealOutcome>> {
  const maxRounds = resolveMaxRounds(opts.maxRounds);
  const result = new Map<string, HealOutcome>();

  if (inputs.length === 0) return result;

  // AI unavailable → nothing can be healed; report honestly, do not quarantine
  // (this is an infra/config gap, not an unfixable test).
  if (!opts.canUseAi) {
    for (const input of inputs) {
      result.set(input.id, {
        id: input.id,
        healed: false,
        finalCode: input.code,
        finalStatus: 'failed',
        finalError: input.initialError,
        category: categorizeFailure(input.initialError),
        quarantined: false,
        attempts: [],
        summary: 'AI engine not connected — could not generate a fix.',
      });
    }
    return result;
  }

  const states: HealState[] = inputs.map((input) => ({
    input,
    currentCode: input.code,
    lastError: input.initialError,
    history: [],
    triedCodes: new Set([input.code.trim()]),
    done: false,
    healed: false,
    finalCode: input.code,
    finalStatus: 'failed',
    finalError: input.initialError,
    quarantined: false,
  }));

  let verifyError: unknown = null;
  for (let round = 1; round <= maxRounds; round++) {
    const active = states.filter((s) => !s.done);
    if (active.length === 0) break;

    // 1) AI-fix each active spec (retry-resilient parse + anti-cheat), bounded to
    //    AI_CONCURRENCY simultaneous Claude calls so a large failing set can't
    //    fan out into a rate-limit/cost spike.
    const candidates = await mapLimit(
      active,
      AI_CONCURRENCY,
      async (st): Promise<{ st: HealState; fix: HealingFix; newCode: string } | null> => {
        const attemptNo = st.history.length + 1;
        let fix: HealingFix | null = null;
        try {
          const prompt = buildHealingPrompt({
            title: st.input.intent.title,
            feature: st.input.intent.feature,
            type: st.input.intent.type,
            precondition: st.input.intent.precondition,
            steps: st.input.intent.steps,
            expectedResult: st.input.intent.expectedResult,
            fileName: st.input.fileName,
            code: st.currentCode,
            error: st.lastError,
            targetUrl: opts.targetUrl,
            attemptHistory: st.history,
          });
          fix = await runClaudeJson<HealingFix>(prompt, { maxTokens: 16000, model: 'claude-sonnet-4-6', attempts: 2 });
        } catch (err) {
          st.history.push({ attempt: attemptNo, diagnosis: '', fix: '', outcome: 'ai-error', error: (err as Error)?.message });
          return null;
        }

        const newCode = (fix?.code || '').trim();
        if (!newCode || isNoOpFix(st.currentCode, newCode)) {
          st.history.push({ attempt: attemptNo, diagnosis: fix?.diagnosis || '', fix: fix?.fix || '', outcome: 'no-change' });
          return null;
        }

        // Anti-cheat: always compare against the ORIGINAL spec, never the latest
        // candidate — so weakening can't creep in one assertion at a time.
        const weak = detectAssertionWeakening(st.input.code, newCode);
        if (weak.weakened) {
          st.history.push({ attempt: attemptNo, diagnosis: fix?.diagnosis || '', fix: fix?.fix || '', outcome: 'rejected-weakening', weakeningReasons: weak.reasons });
          return null;
        }

        if (st.triedCodes.has(newCode)) {
          st.history.push({ attempt: attemptNo, diagnosis: fix?.diagnosis || '', fix: fix?.fix || '', outcome: 'stuck' });
          st.done = true;
          st.quarantined = true;
          return null;
        }
        st.triedCodes.add(newCode);
        return { st, fix, newCode };
      },
    );

    const toVerify = candidates.filter(
      (c): c is { st: HealState; fix: HealingFix; newCode: string } => c !== null,
    );
    if (toVerify.length === 0) break; // no usable candidate this round → no progress

    // 2) Verify ALL candidates in one batched Playwright run. If Playwright cannot
    //    run at all (e.g. browsers missing), do NOT lose prior-round heals: stop
    //    and finalize. The error is re-thrown after the loop only if nothing was
    //    healed, so the caller still gets the actionable infra message.
    try {
      const verdicts = await verify(
        toVerify.map((c) => ({ key: c.st.input.id, fileName: c.st.input.fileName, code: c.newCode })),
      );
      // 3) Partition pass/fail; feed each failure's new error into the next round.
      for (const c of toVerify) {
        const v = verdicts.get(c.st.input.id) || { status: 'not_run' as const };
        const attemptNo = c.st.history.length + 1;
        if (v.status === 'passed') {
          c.st.healed = true;
          c.st.done = true;
          c.st.finalCode = c.newCode;
          c.st.finalStatus = 'passed';
          c.st.finalError = undefined;
          c.st.durationMs = v.durationMs;
          c.st.history.push({ attempt: attemptNo, diagnosis: c.fix.diagnosis, fix: c.fix.fix, outcome: 'passed' });
        } else {
          // failed / flaky / not_run — a flaky candidate (passed only on retry) is
          // intentionally NOT trusted as a stable heal; keep iterating.
          c.st.lastError = v.error || c.st.lastError;
          c.st.currentCode = c.newCode; // iterate on the latest attempt with the fresh error
          c.st.finalError = c.st.lastError;
          c.st.history.push({ attempt: attemptNo, diagnosis: c.fix.diagnosis, fix: c.fix.fix, outcome: 'still-failing', error: v.error });
        }
      }
    } catch (err) {
      verifyError = err;
      break;
    }
  }

  // If verification itself was impossible (e.g. browsers not installed) and we
  // healed nothing, surface that actionable error instead of silently quarantining.
  if (verifyError && !states.some((s) => s.healed)) throw verifyError;

  // Finalize: anything not healed is a failed run; if it consumed attempts without
  // a verified fix (and wasn't already marked stuck), it is quarantined.
  for (const st of states) {
    if (!st.healed) {
      st.finalStatus = 'failed';
      st.finalCode = st.input.code; // never persist unverified code
      if (st.history.length > 0) st.quarantined = true;
    }
    result.set(st.input.id, {
      id: st.input.id,
      healed: st.healed,
      finalCode: st.finalCode,
      finalStatus: st.finalStatus,
      finalError: st.healed ? undefined : st.finalError,
      durationMs: st.durationMs,
      category: categorizeFailure(st.input.initialError),
      quarantined: st.quarantined,
      attempts: st.history,
      summary: buildSummary(st),
    });
  }

  return result;
}
