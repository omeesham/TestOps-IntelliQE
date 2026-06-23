/**
 * Shared frontend types — kept minimal. Page-specific types live in the
 * page/component that uses them. Only export types referenced by 2+ files.
 */

export type AgentStatusValue = 'idle' | 'active' | 'running' | 'error' | 'completed';

export type PipelineStage =
  | 'pending_requirements'
  | 'requirements'
  | 'pending_planning'
  | 'planning'
  | 'pending_generation'
  | 'generation'
  | 'testing'
  | 'pending_healing'
  | 'healing'
  | 'completed'
  | 'fixme';

export interface AgentInfo {
  id: string;
  name: string;
  agentFile: string;
  status: AgentStatusValue;
  description: string;
  model: string;
  tools: string[];
  lastRun?: string;
  queueSize: number;
  processingTime?: string;
  icon: string;
  handoffTo?: string;
  pipelineOrder: number;
}

export interface QueueItem {
  id: string;
  feature: string;
  module: string;
  stage: PipelineStage;
  priority: 'P0' | 'P1' | 'P2';
  lockedBy: string | null;
  intent: string;
  artifacts: {
    testCaseFile?: string;
    testPlanFile?: string;
    specFiles?: string[];
  };
  history: { agent: string; action: string; timestamp: string }[];
  totalTcCount: number;
  automatableCount: number;
}

/* ─────────────────────────────────────────────────────────────
   Test data (used by ChatPage / TestDataTab / ReportsTab)
   ───────────────────────────────────────────────────────────── */
export interface TestFieldData {
  id: string;
  field_name: string;
  value: string;
  type: 'valid' | 'invalid';
  data_type: string;
  validation_rule?: string;
  source: 'static' | 'database' | 'api' | 'computed';
  source_detail?: string;
}

export interface TestDataset {
  dataset_id: string;
  role: string;
  scenario: string;
  fields: Record<string, string>;
  layer: 'ui' | 'api' | 'both';
  source: 'static' | 'database' | 'mixed';
  source_config?: {
    db_table?: string;
    db_query?: string;
    connection_id?: string;
    description?: string;
  };
}

export interface TestDataMapping {
  test_case_id: string;
  dataset_id: string;
}

export interface DataValidationExpectation {
  field: string;
  value: string;
  validation: 'accepted' | 'rejected';
  reason: string;
}

/* ─────────────────────────────────────────────────────────────
   Reports (used by ReportsTab)
   ───────────────────────────────────────────────────────────── */
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

export interface RunReport {
  run: { id: string; feature: string; module: string; status: string; created_at: string };
  executionSummary: ExecutionSummary;
  dataReport: DataReport;
  accessibilityReport: {
    total_elements_checked: number;
    violations: Array<{ element: string; violation: string; severity: string; wcag_criteria: string; recommendation: string }>;
    pass_count: number;
    fail_count: number;
    generated_at: string;
    /** 'not_run' = no real axe-core scan ran; UI must show this honestly, not as a green pass. */
    scan_status: 'not_run' | 'completed' | 'partial';
  } | null;
}
