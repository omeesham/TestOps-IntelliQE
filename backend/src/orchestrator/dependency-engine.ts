import type { Db as Pool } from '../db.js';
import type { PipelineDefinition, PageStageStatus } from './types.js';

const SCHEMA = '"JBSTestOpsAI"';

export function getStageOrder(definition: PipelineDefinition): string[] {
  return definition.stages.filter(s => s.enabled).map(s => s.id);
}

export function getPrerequisites(definition: PipelineDefinition, targetStage: string): string[] {
  const order = getStageOrder(definition);
  const targetIdx = order.indexOf(targetStage);
  if (targetIdx <= 0) return [];
  return order.slice(0, targetIdx);
}

export interface PageReadiness {
  satisfied: boolean;
  missing: string[];
  failed: string[];
  inProgress: string[];
  needsRequirements: boolean;
  canAutoCascade: boolean;
}

export async function checkPageReadiness(
  pool: Pool,
  pageId: string,
  targetStage: string,
  definition: PipelineDefinition,
): Promise<PageReadiness> {
  const prerequisites = getPrerequisites(definition, targetStage);
  if (prerequisites.length === 0) {
    const { rows } = await pool.query(`SELECT target_url FROM ${SCHEMA}.qa_pages WHERE id = $1`, [pageId]);
    const page = rows[0];
    const isFirstStage = getStageOrder(definition)[0] === targetStage;
    return {
      satisfied: true, missing: [], failed: [], inProgress: [],
      needsRequirements: isFirstStage && !page?.target_url,
      canAutoCascade: true,
    };
  }

  const { rows: statuses } = await pool.query<PageStageStatus>(
    `SELECT * FROM ${SCHEMA}.qa_page_stage_status WHERE page_id = $1`, [pageId]
  );
  const statusMap = new Map(statuses.map(s => [s.stage_id, s]));

  const missing: string[] = [];
  const failed: string[] = [];
  const inProgress: string[] = [];

  for (const prereq of prerequisites) {
    const status = statusMap.get(prereq);
    if (!status || status.status === 'not_started') missing.push(prereq);
    else if (status.status === 'failed') failed.push(prereq);
    else if (status.status === 'running') inProgress.push(prereq);
  }

  const { rows: pageRows } = await pool.query(`SELECT target_url FROM ${SCHEMA}.qa_pages WHERE id = $1`, [pageId]);
  const page = pageRows[0];
  const firstStage = getStageOrder(definition)[0];
  const needsRequirements = firstStage
    ? (missing.includes(firstStage) || !statusMap.has(firstStage)) && !page?.target_url
    : false;

  return {
    satisfied: missing.length === 0 && failed.length === 0 && inProgress.length === 0,
    missing, failed, inProgress, needsRequirements,
    canAutoCascade: inProgress.length === 0,
  };
}

export async function buildCascadePlan(
  pool: Pool,
  pageId: string,
  targetStage: string,
  definition: PipelineDefinition,
): Promise<string[]> {
  const readiness = await checkPageReadiness(pool, pageId, targetStage, definition);
  if (readiness.satisfied) return [targetStage];
  const order = getStageOrder(definition);
  const needsRun = new Set([...readiness.missing, ...readiness.failed, targetStage]);
  return order.filter(s => needsRun.has(s));
}
