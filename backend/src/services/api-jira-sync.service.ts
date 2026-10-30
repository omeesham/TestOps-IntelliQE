/**
 * api-jira-sync.service.ts — Jira adapter over the provider-agnostic defect-sync
 * core (Module 4). The create/comment calls are Jira-specific; the dedupe,
 * signature, persistence and history all live in api-defect-sync.service.ts.
 */
import { getCredsForTenant, createBug, addComment, type JiraCreds } from './jira.service.js';
import {
  syncDefects as coreSync, listSyncHistory as coreHistory, listDefectLinks as coreLinks,
  type DefectAdapter, type SyncDefectInput, type SyncDefectResponse, type SyncHistoryRow, type DefectLinkRow,
} from './api-defect-sync.service.js';

export { failureSignature } from './api-defect-sync.service.js';
export type { RunFailure, SyncDefectInput, SyncDefectResult, SyncDefectResponse, SyncAction, SyncHistoryRow, DefectLinkRow } from './api-defect-sync.service.js';

const jiraAdapter: DefectAdapter<JiraCreds> = {
  provider: 'jira',
  getCreds: getCredsForTenant,
  createDefect: (creds, d) => createBug(creds, { title: d.title, description: d.description, actualResult: d.actualResult, environment: d.environment, tags: d.tags }),
  addComment: (creds, key, text) => addComment(creds, key, text),
};

export function syncDefects(tenantId: string, username: string, input: SyncDefectInput): Promise<SyncDefectResponse> {
  return coreSync(tenantId, username, input, jiraAdapter);
}
export function listSyncHistory(tenantId: string, limit = 50): Promise<SyncHistoryRow[]> {
  return coreHistory(tenantId, 'jira', limit);
}
export function listDefectLinks(tenantId: string, runId?: string, limit = 100): Promise<DefectLinkRow[]> {
  return coreLinks(tenantId, 'jira', runId, limit);
}
