/**
 * renderer.ts — the deterministic render seam.
 *
 * In the production platform this stage renders each NormalizedCase into a
 * runnable Playwright `request` spec (a .ts file) + a service object. In the
 * prototype the Renderer validates/normalizes the typed checks and attaches
 * human-readable labels, producing an ExecutableCase the in-process Executor
 * consumes directly.
 *
 * Keeping this as its own module (and its own type) is deliberate: swapping the
 * in-process engine for real Playwright spec-file rendering is a RENDERER-ONLY
 * change — the Generator (model → typed JSON) and the Executor contract are
 * untouched. That is the whole point of the invariant.
 */
import type { ApiCheck, NormalizedCase } from './types';
import { describeCheck } from './executor';

export interface RenderedCheck {
  check: ApiCheck;
  /** Human-readable intent of this assertion, for the report / a future spec file. */
  label: string;
}

export interface ExecutableCase {
  case: NormalizedCase;
  /** The checks, each paired with its rendered label. */
  rendered: RenderedCheck[];
}

/** Valid ApiCheck kinds — anything else the model emitted is dropped here. */
const VALID_KINDS = new Set<ApiCheck['kind']>([
  'status',
  'ok',
  'notOk',
  'jsonProperty',
  'jsonArrayNotEmpty',
  'header',
  'bodyContains',
  'responseTimeUnderMs',
]);

/**
 * Render one case. Drops any check whose kind is outside the closed set (the
 * last line of defence that keeps execution deterministic), and guarantees at
 * least one assertion so no case runs assertion-free.
 */
export function render(nc: NormalizedCase): ExecutableCase {
  const valid = (nc.checks || []).filter((c) => c && VALID_KINDS.has(c.kind));
  const checks = valid.length ? valid : [{ kind: 'ok' as const }];
  return {
    case: { ...nc, checks },
    rendered: checks.map((check) => ({ check, label: describeCheck(check) })),
  };
}

export function renderAll(cases: NormalizedCase[]): ExecutableCase[] {
  return cases.map(render);
}
