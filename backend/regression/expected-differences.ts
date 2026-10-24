/**
 * Deliberate behaviour changes since the approved results were recorded.
 * A difference listed here is reported but does not fail the run; any other
 * difference is a regression. Give every entry its reason.
 */
export const API_DIFFERENCES: Record<string, string> = {
  // 'GET /api/example': 'why the status or shape changed on purpose',
};

/**
 * Known product bugs that exist on the approved build too. They are reported,
 * not failed, so a run shows only new breakage. Remove an entry once fixed.
 */
export const KNOWN_ISSUES: { pattern: RegExp; issue: string }[] = [
  { pattern: /\/api\/test-cases\/facets/, issue: 'Facets query uses Postgres UNNEST on SQL Server (500); module/tag filters stay empty' },
];
