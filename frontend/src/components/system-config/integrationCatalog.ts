/**
 * Shared integration catalog — single source of truth for all integrations.
 * Kept lean to match the current SaaS scope:
 *   - Requirement sources (Jira / Confluence / SharePoint)
 *   - Git repositories (GitHub / GitLab / Bitbucket) for script delivery
 *   - Notification channels (Outlook email / Slack / Microsoft Teams)
 */

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  categoryKey: string;
  description: string;
  comingSoon: boolean;
  logo?: string;
  fields: { key: string; label: string; placeholder: string; type?: string; optional?: boolean; hint?: string }[];
}

export const LOGOS: Record<string, string> = {
  jira: 'https://cdn.simpleicons.org/jira/0052CC',
  'azure-devops': 'https://cdn.simpleicons.org/azuredevops/0078D7',
  confluence: 'https://cdn.simpleicons.org/confluence/172B4D',
  sharepoint: '',
  github: 'https://cdn.simpleicons.org/github/181717',
  gitlab: 'https://cdn.simpleicons.org/gitlab/FC6D26',
  bitbucket: 'https://cdn.simpleicons.org/bitbucket/0052CC',
  'notif-email': 'https://api.iconify.design/selfhst/microsoft-outlook-2018.svg',
  'notif-slack': 'https://api.iconify.design/logos/slack-icon.svg',
  'notif-teams': 'https://api.iconify.design/logos/microsoft-teams.svg',
};

export const INTEGRATION_CATALOG: CatalogItem[] = [
  // ──── Requirement Sources ────
  {
    id: 'jira', name: 'JIRA', category: 'Project Management', categoryKey: 'requirement-source',
    description: 'User stories and acceptance criteria from JIRA',
    comingSoon: false,
    fields: [
      { key: 'jira_url', label: 'JIRA URL', placeholder: 'https://your-org.atlassian.net' },
      { key: 'email', label: 'Email', placeholder: 'user@company.com' },
      { key: 'api_token', label: 'API Token', placeholder: 'Your JIRA API token', type: 'password' },
    ],
  },
  {
    id: 'azure-devops', name: 'Azure DevOps', category: 'Boards & Test Plans', categoryKey: 'requirement-source',
    description: 'Work items and test cases from Azure Boards',
    comingSoon: false,
    fields: [
      { key: 'org_url', label: 'Organization URL', placeholder: 'https://dev.azure.com/your-org' },
      { key: 'project', label: 'Project', placeholder: 'MyProject' },
      { key: 'pat', label: 'Personal Access Token', placeholder: 'PAT with Work Items (Read) + Test Management (Read)', type: 'password' },
      { key: 'areaPath', label: 'Area Path (optional)', placeholder: 'MyProject\\QA' },
    ],
  },
  {
    id: 'confluence', name: 'Confluence', category: 'Documentation', categoryKey: 'requirement-source',
    description: 'Requirements and specs from Confluence pages',
    comingSoon: false,
    fields: [
      { key: 'url', label: 'Confluence URL', placeholder: 'https://your-org.atlassian.net/wiki' },
      { key: 'email', label: 'Email', placeholder: 'user@company.com' },
      { key: 'api_token', label: 'API Token', placeholder: 'Your Confluence API token', type: 'password' },
    ],
  },
  {
    id: 'sharepoint', name: 'SharePoint', category: 'Document Management', categoryKey: 'requirement-source',
    description: 'Requirements from SharePoint document libraries',
    comingSoon: false,
    fields: [
      { key: 'siteUrl', label: 'Site URL', placeholder: 'https://org.sharepoint.com/sites/QA' },
      // Azure AD directory (tenant) ID — required for ClientSecretCredential.
      // Distinct from the IntelliQE tenant_id; this is the Microsoft 365 tenant.
      { key: 'tenantId', label: 'Azure AD Tenant ID', placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'clientId', label: 'Application (client) ID', placeholder: '11111111-1111-1111-1111-111111111111' },
      { key: 'clientSecret', label: 'Client Secret', placeholder: 'Client secret value', type: 'password' },
    ],
  },

  // ──── Git Repositories ────
  {
    id: 'github', name: 'GitHub', category: 'Version Control', categoryKey: 'git-repo',
    description: 'Push generated automation scripts to GitHub repositories',
    comingSoon: false,
    fields: [
      { key: 'repo_url', label: 'Repository URL', placeholder: 'https://github.com/org/repo' },
      { key: 'branch', label: 'Default Branch (PR target)', placeholder: 'main' },
      { key: 'scripts_path', label: 'Scripts Path (folder)', placeholder: 'tests/', optional: true, hint: 'Folder in the repo where generated scripts are committed. Leave blank to use tests/.' },
      { key: 'access_token', label: 'Access Token', placeholder: 'ghp_...', type: 'password' },
    ],
  },
  {
    id: 'gitlab', name: 'GitLab', category: 'Version Control', categoryKey: 'git-repo',
    description: 'Push automation scripts to GitLab repositories',
    comingSoon: false,
    fields: [
      { key: 'repo_url', label: 'Repository URL', placeholder: 'https://gitlab.com/org/repo' },
      { key: 'branch', label: 'Default Branch (MR target)', placeholder: 'main' },
      { key: 'scripts_path', label: 'Scripts Path (folder)', placeholder: 'tests/', optional: true, hint: 'Folder in the repo where generated scripts are committed. Leave blank to use tests/.' },
      { key: 'access_token', label: 'Personal Access Token', placeholder: 'glpat-...', type: 'password' },
    ],
  },
  {
    id: 'bitbucket', name: 'Bitbucket', category: 'Version Control', categoryKey: 'git-repo',
    description: 'Push automation scripts to Bitbucket repositories',
    comingSoon: false,
    fields: [
      { key: 'repo_url', label: 'Repository URL', placeholder: 'https://bitbucket.org/org/repo' },
      { key: 'branch', label: 'Default Branch (PR target)', placeholder: 'main' },
      { key: 'scripts_path', label: 'Scripts Path (folder)', placeholder: 'tests/', optional: true, hint: 'Folder in the repo where generated scripts are committed. Leave blank to use tests/.' },
      { key: 'username', label: 'Username', placeholder: 'your-username' },
      { key: 'app_password', label: 'App Password', placeholder: 'Bitbucket app password', type: 'password' },
    ],
  },

  // ──── Notifications ────
  {
    id: 'notif-email', name: 'Outlook', category: 'Email', categoryKey: 'notification',
    description: 'Test-run results delivered by email',
    comingSoon: false,
    fields: [
      { key: 'smtpHost', label: 'SMTP Host', placeholder: 'smtp.office365.com' },
      { key: 'smtpPort', label: 'SMTP Port', placeholder: '587' },
      { key: 'smtpUser', label: 'Outlook Email', placeholder: 'alerts@yourcompany.com' },
      { key: 'smtpPassword', label: 'Password / App Password', placeholder: '••••••••', type: 'password' },
      { key: 'fromEmail', label: 'From Display Email', placeholder: 'noreply@yourcompany.com' },
      { key: 'toEmail', label: 'To (Primary Recipients)', placeholder: 'qa-lead@company.com, ops@company.com' },
      { key: 'ccEmail', label: 'CC (Copy Recipients)', placeholder: 'manager@company.com' },
    ],
  },
  {
    id: 'notif-slack', name: 'Slack', category: 'Chat', categoryKey: 'notification',
    description: 'Test-run alerts in a Slack channel',
    comingSoon: false,
    fields: [
      { key: 'webhook_url', label: 'Incoming Webhook URL', placeholder: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX', type: 'password' },
      { key: 'channel', label: 'Default Channel (optional)', placeholder: '#qa-alerts' },
      { key: 'botName', label: 'Bot Display Name (optional)', placeholder: 'IntelliQE Bot' },
    ],
  },
  {
    id: 'notif-teams', name: 'Microsoft Teams', category: 'Chat', categoryKey: 'notification',
    description: 'Test-run alerts in a Teams channel',
    comingSoon: false,
    fields: [
      { key: 'webhook_url', label: 'Incoming Webhook URL', placeholder: 'https://<org>.webhook.office.com/webhookb2/...', type: 'password' },
      { key: 'channelName', label: 'Channel Name (optional)', placeholder: 'QA Notifications' },
    ],
  },

];

/**
 * Prefill values for editing a saved integration: only the catalog-declared
 * field keys, and never encrypted secrets (the user re-enters those).
 */
export function prefillFromConfig(item: CatalogItem, configData: Record<string, any> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!configData) return out;
  for (const f of item.fields) {
    const v = configData[f.key];
    if (v === undefined || v === null || typeof v === 'object') continue;
    const s = String(v);
    if (/^__(?:ENC|AES)__/.test(s)) continue;
    out[f.key] = s;
  }
  return out;
}

export function getRequirementSources(): CatalogItem[] {
  return INTEGRATION_CATALOG.filter((i) => i.categoryKey === 'requirement-source');
}
export function getGitRepos(): CatalogItem[] {
  return INTEGRATION_CATALOG.filter((i) => i.categoryKey === 'git-repo');
}
export function getNotifications(): CatalogItem[] {
  return INTEGRATION_CATALOG.filter((i) => i.categoryKey === 'notification');
}
