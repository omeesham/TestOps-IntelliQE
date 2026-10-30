/**
 * api-azure-sync.service.ts — Azure DevOps adapter over the provider-agnostic
 * defect-sync core (Module 5). Creates Bug work items and comments on recurrence;
 * the dedupe, signature, persistence and history are shared with Jira via
 * api-defect-sync.service.ts (provider = 'azure' on the shared tables).
 */
import { getCredsForTenant, createBug, addComment, type AdoCreds } from './azure-devops.service.js';
import {
  syncDefects as coreSync, listSyncHistory as coreHistory, listDefectLinks as coreLinks,
  type DefectAdapter, type SyncDefectInput, type SyncDefectResponse, type SyncHistoryRow, type DefectLinkRow,
} from './api-defect-sync.service.js';

const azureAdapter: DefectAdapter<AdoCreds> = {
  provider: 'azure',
  getCreds: getCredsForTenant,
  createDefect: async (creds, d) => {
    const bug = await createBug(creds, { title: d.title, description: d.description, actualResult: d.actualResult, environment: d.environment, tags: d.tags });
    return { key: String(bug.id), url: bug.url };
  },
  addComment: (creds, key, text) => addComment(creds, key, text),
};

export function syncDefects(tenantId: string, username: string, input: SyncDefectInput): Promise<SyncDefectResponse> {
  return coreSync(tenantId, username, input, azureAdapter);
}
export function listSyncHistory(tenantId: string, limit = 50): Promise<SyncHistoryRow[]> {
  return coreHistory(tenantId, 'azure', limit);
}
export function listDefectLinks(tenantId: string, runId?: string, limit = 100): Promise<DefectLinkRow[]> {
  return coreLinks(tenantId, 'azure', runId, limit);
}
