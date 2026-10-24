/**
 * Normalising test case values before they reach the test_cases table: AI
 * output can be longer than a column, and one oversized value would otherwise
 * fail the whole insert.
 */

/** NVARCHAR sizes of the test_cases columns (see db.ts). */
export const TEST_CASE_LIMITS = {
  tc_number: 20,
  title: 1000,
  priority: 10,
  type: 50,
  feature: 200,
  status: 50,
  module: 200,
  submodule: 200,
  severity: 20,
  traceability_id: 1000,
  category: 30,
} as const;

/** The value as a string trimmed to `max` characters, ending in "…" when cut; null stays null. */
export function fit(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const TAG_VOCAB = [
  'POSITIVE', 'NEGATIVE', 'E2E', 'UI', 'API', 'SMOKE', 'REGRESSION',
  'SANITY', 'AUTH', 'SECURITY', 'ACCESSIBILITY', 'DATA-VALIDATION',
];

/** Known tags only, upper-cased and de-duplicated. */
export function normaliseTags(input: unknown): string[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,;|[\]]+/);
  return Array.from(new Set(arr.map((t) => String(t).toUpperCase().trim()).filter((t) => TAG_VOCAB.includes(t))));
}

export const TEST_CASE_CATEGORIES = ['positive', 'negative', 'boundary', 'business-rule', 'edge', 'security', 'accessibility'];

/** A known test-design category, or null. */
export function normaliseCategory(input: unknown): string | null {
  const v = String(input ?? '').toLowerCase().trim();
  return TEST_CASE_CATEGORIES.includes(v) ? v : null;
}
