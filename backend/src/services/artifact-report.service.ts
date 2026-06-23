import archiver from 'archiver';
import type { Writable } from 'stream';

export interface ExecutionSummary {
  total_tests: number;
  passed: number;
  failed: number;
  skipped: number;
  pass_rate: number;
  execution_time_ms: number;
  type_breakdown: Record<string, number>;
  priority_breakdown: Record<string, number>;
  generated_at: string;
}

export interface DataReport {
  total_datasets: number;
  total_field_data: number;
  total_mappings: number;
  mapping_coverage: number;
  unmapped_test_cases: string[];
  datasets_by_role: Record<string, number>;
  datasets_by_layer: Record<string, number>;
  generated_at: string;
}

export interface AccessibilityReportItem {
  element: string;
  violation: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  wcag_criteria: string;
  recommendation: string;
}

export interface AccessibilityReport {
  total_elements_checked: number;
  violations: AccessibilityReportItem[];
  pass_count: number;
  fail_count: number;
  generated_at: string;
  /**
   * 'not_run' means no real a11y scan has been performed yet — the
   * report exists only to enumerate the elements that WOULD be checked.
   * 'completed' means real violations[] is the truth of the matter.
   * Frontends should display the 'not_run' case prominently rather than
   * showing a misleading "0 violations" green checkmark.
   */
  scan_status: 'not_run' | 'completed' | 'partial';
}

/**
 * Shape of a real axe-core violation entry. Same names as `axe-core`'s
 * Result, narrowed to the fields we surface in the report.
 */
export interface AxeViolation {
  id: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical';
  tags?: string[];           // e.g., ['wcag2a', 'wcag143', 'cat.color']
  description?: string;
  help?: string;
  helpUrl?: string;
  nodes?: { target?: string[]; html?: string; failureSummary?: string }[];
}

export function compileExecutionSummary(
  testCases: Array<{ id: string; type: string; priority: string; status: string }>,
  executionTimeMs?: number,
): ExecutionSummary {
  const total = testCases.length;
  const passed = testCases.filter(tc => tc.status === 'passed').length;
  const failed = testCases.filter(tc => tc.status === 'failed').length;
  const skipped = testCases.filter(tc => tc.status === 'generated').length;

  const typeBreakdown: Record<string, number> = {};
  const priorityBreakdown: Record<string, number> = {};

  for (const tc of testCases) {
    typeBreakdown[tc.type] = (typeBreakdown[tc.type] || 0) + 1;
    priorityBreakdown[tc.priority] = (priorityBreakdown[tc.priority] || 0) + 1;
  }

  return {
    total_tests: total,
    passed,
    failed,
    skipped,
    pass_rate: total > 0 ? Math.round((passed / total) * 100) : 0,
    execution_time_ms: executionTimeMs || 0,
    type_breakdown: typeBreakdown,
    priority_breakdown: priorityBreakdown,
    generated_at: new Date().toISOString(),
  };
}

export function compileDataReport(
  datasets: Array<{ dataset_id: string; role: string; layer: string }>,
  mappings: Array<{ test_case_id: string; dataset_id: string }>,
  testCases: Array<{ id: string }>,
): DataReport {
  const mappedTcIds = new Set(mappings.map(m => m.test_case_id));
  const unmapped = testCases.filter(tc => !mappedTcIds.has(tc.id)).map(tc => tc.id);

  const datasetsByRole: Record<string, number> = {};
  const datasetsByLayer: Record<string, number> = {};
  for (const ds of datasets) {
    datasetsByRole[ds.role] = (datasetsByRole[ds.role] || 0) + 1;
    datasetsByLayer[ds.layer] = (datasetsByLayer[ds.layer] || 0) + 1;
  }

  return {
    total_datasets: datasets.length,
    total_field_data: 0, // caller sets this
    total_mappings: mappings.length,
    mapping_coverage: testCases.length > 0 ? Math.round((mappedTcIds.size / testCases.length) * 100) : 0,
    unmapped_test_cases: unmapped,
    datasets_by_role: datasetsByRole,
    datasets_by_layer: datasetsByLayer,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Compile an accessibility report from REAL axe-core results when they
 * are available, or honestly mark the report as `not_run` when they are
 * not. NEVER pretend a clean pass without evidence.
 *
 * Inputs:
 *   accessibilityData  Expected-behaviour catalogue (the elements a
 *                      reviewer wanted to check). Used only for the
 *                      `total_elements_checked` baseline.
 *   axeResults         Optional array of real axe-core violation objects
 *                      produced by a Playwright + @axe-core/playwright
 *                      run. When omitted/empty AND no real scan happened,
 *                      the report is marked `not_run`.
 *   scanWasRun         Explicit flag so callers can mark `completed` with
 *                      zero violations — i.e., a real clean pass.
 */
export function compileAccessibilityReport(
  accessibilityData: Array<{ element: string; label: string; aria_role: string; tab_order?: number; expected_behavior: string }>,
  axeResults?: AxeViolation[],
  scanWasRun: boolean = false,
): AccessibilityReport {
  // If no scan was actually run, return an honest "not_run" report.
  // We do NOT fabricate a passing report from the expected-behaviour list.
  if (!scanWasRun && (!axeResults || axeResults.length === 0)) {
    return {
      total_elements_checked: accessibilityData.length,
      violations: [],
      pass_count: 0,
      fail_count: 0,
      generated_at: new Date().toISOString(),
      scan_status: 'not_run',
    };
  }

  // Real scan happened — translate axe violations into our report items.
  const violations: AccessibilityReportItem[] = [];
  for (const v of (axeResults || [])) {
    // axe gives one Result per rule; each Result can have many failing nodes.
    // We emit one report row per (rule × node) pair so reviewers see exactly
    // which element broke which rule.
    const wcagTags = (v.tags || []).filter((t) => /^wcag/i.test(t));
    const wcagCriteria = wcagTags.length ? wcagTags.join(', ') : 'WCAG (unspecified)';
    for (const node of (v.nodes && v.nodes.length ? v.nodes : [{}])) {
      violations.push({
        element: node.target?.join(' ') || node.html?.slice(0, 200) || '(unknown)',
        violation: v.help || v.description || v.id,
        severity: (v.impact as AccessibilityReportItem['severity']) || 'moderate',
        wcag_criteria: wcagCriteria,
        recommendation: node.failureSummary || v.helpUrl || 'See axe-core documentation',
      });
    }
  }

  return {
    total_elements_checked: accessibilityData.length,
    violations,
    // pass_count is elements that were checked AND not flagged — a real
    // measure now, not a constant equal to elements-checked.
    pass_count: Math.max(0, accessibilityData.length - violations.length),
    fail_count: violations.length,
    generated_at: new Date().toISOString(),
    scan_status: 'completed',
  };
}

export interface ZipContents {
  testCases: unknown[];
  datasets?: unknown[];
  fieldData?: unknown[];
  mappings?: unknown[];
  validations?: unknown[];
  accessibilityData?: unknown[];
  executionSummary: ExecutionSummary;
  dataReport: DataReport;
  accessibilityReport?: AccessibilityReport;
  automationScripts?: Array<{ file_name: string; code: string }>;
}

export function buildArtifactZip(data: ZipContents, output: Writable): void {
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(output);

  // Test cases
  archive.append(JSON.stringify(data.testCases, null, 2), { name: 'test-cases.json' });

  // Test data folder
  if (data.datasets && data.datasets.length > 0) {
    archive.append(JSON.stringify(data.datasets, null, 2), { name: 'test-data/datasets.json' });
  }
  if (data.fieldData && data.fieldData.length > 0) {
    archive.append(JSON.stringify(data.fieldData, null, 2), { name: 'test-data/field-data.json' });
  }
  if (data.mappings && data.mappings.length > 0) {
    archive.append(JSON.stringify(data.mappings, null, 2), { name: 'test-data/mappings.json' });
  }
  if (data.validations && data.validations.length > 0) {
    archive.append(JSON.stringify(data.validations, null, 2), { name: 'test-data/validations.json' });
  }
  if (data.accessibilityData && data.accessibilityData.length > 0) {
    archive.append(JSON.stringify(data.accessibilityData, null, 2), { name: 'test-data/accessibility-data.json' });
  }

  // Reports folder
  archive.append(JSON.stringify(data.executionSummary, null, 2), { name: 'reports/execution-summary.json' });
  archive.append(JSON.stringify(data.dataReport, null, 2), { name: 'reports/data-report.json' });
  if (data.accessibilityReport) {
    archive.append(JSON.stringify(data.accessibilityReport, null, 2), { name: 'reports/accessibility-report.json' });
  }

  // Automation scripts folder
  if (data.automationScripts) {
    for (const script of data.automationScripts) {
      archive.append(script.code, { name: `scripts/${script.file_name}` });
    }
  }

  archive.finalize();
}
