/**
 * Shared integration catalog — single source of truth for all integrations.
 * Kept lean to match the current SaaS scope:
 *   - Requirement sources (Jira / Confluence / SharePoint)
 *   - Storage providers (Azure Blob / AWS S3 / GCP Storage) for test artifacts
 *   - Git repositories (GitHub / GitLab / Bitbucket) for script delivery
 *   - Email notification
 *   - Jenkins CI/CD
 *   - Postman (future API automation)
 */

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  categoryKey: string;
  description: string;
  comingSoon: boolean;
  logo?: string;
  fields: { key: string; label: string; placeholder: string; type?: string }[];
}

export const LOGOS: Record<string, string> = {
  jira: 'https://cdn.simpleicons.org/jira/0052CC',
  confluence: 'https://cdn.simpleicons.org/confluence/172B4D',
  sharepoint: '',
  github: 'https://cdn.simpleicons.org/github/181717',
  gitlab: 'https://cdn.simpleicons.org/gitlab/FC6D26',
  bitbucket: 'https://cdn.simpleicons.org/bitbucket/0052CC',
  'notif-email': '',
  jenkins: 'https://cdn.simpleicons.org/jenkins/D24939',
  'azure-blob': 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/azure/azure-original.svg',
  'aws-s3': 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/amazonwebservices/amazonwebservices-original-wordmark.svg',
  'gcp-storage': 'https://cdn.simpleicons.org/googlecloud/4285F4',
  postman: 'https://cdn.simpleicons.org/postman/FF6C37',
};

export const INTEGRATION_CATALOG: CatalogItem[] = [
  // ──── Requirement Sources ────
  {
    id: 'jira', name: 'JIRA', category: 'Project Management', categoryKey: 'requirement-source',
    description: 'Import user stories and acceptance criteria into the test-generation pipeline',
    comingSoon: false,
    fields: [
      { key: 'jira_url', label: 'JIRA URL', placeholder: 'https://your-org.atlassian.net' },
      { key: 'email', label: 'Email', placeholder: 'user@company.com' },
      { key: 'api_token', label: 'API Token', placeholder: 'Your JIRA API token', type: 'password' },
    ],
  },
  {
    id: 'confluence', name: 'Confluence', category: 'Documentation', categoryKey: 'requirement-source',
    description: 'Import requirements and specifications from Confluence pages',
    comingSoon: false,
    fields: [
      { key: 'url', label: 'Confluence URL', placeholder: 'https://your-org.atlassian.net/wiki' },
      { key: 'email', label: 'Email', placeholder: 'user@company.com' },
      { key: 'api_token', label: 'API Token', placeholder: 'Your Confluence API token', type: 'password' },
    ],
  },
  {
    id: 'sharepoint', name: 'SharePoint', category: 'Document Management', categoryKey: 'requirement-source',
    description: 'Import requirements from SharePoint document libraries',
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

  // ──── Storage Providers (for test artifacts) ────
  {
    id: 'azure-blob', name: 'Azure Blob Storage', category: 'Cloud Storage', categoryKey: 'data-source',
    description: 'Store test artifacts (screenshots, traces, reports) in Azure Blob Storage',
    comingSoon: false,
    fields: [
      { key: 'accountName', label: 'Storage Account', placeholder: 'mystorageaccount' },
      { key: 'containerName', label: 'Container Name', placeholder: 'intelliqe-artifacts' },
      { key: 'sasToken', label: 'SAS Token', placeholder: '?sv=2024-11-04&ss=...', type: 'password' },
      { key: 'internalPath', label: 'Path Prefix (optional)', placeholder: 'runs/' },
    ],
  },
  {
    id: 'aws-s3', name: 'AWS S3', category: 'Cloud Storage', categoryKey: 'data-source',
    description: 'Store test artifacts in AWS S3 buckets',
    comingSoon: false,
    fields: [
      { key: 'bucket', label: 'Bucket Name', placeholder: 'my-artifacts-bucket' },
      { key: 'region', label: 'Region', placeholder: 'us-east-1' },
      { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA...' },
      { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: 'Your secret key', type: 'password' },
      { key: 'prefix', label: 'Path Prefix (optional)', placeholder: 'runs/' },
    ],
  },
  {
    id: 'gcp-storage', name: 'GCP Cloud Storage', category: 'Cloud Storage', categoryKey: 'data-source',
    description: 'Store test artifacts in Google Cloud Storage',
    comingSoon: false,
    fields: [
      { key: 'projectId', label: 'Project ID', placeholder: 'my-gcp-project' },
      { key: 'bucket', label: 'Bucket Name', placeholder: 'my-bucket' },
      { key: 'serviceAccountKey', label: 'Service Account Key (JSON)', placeholder: '{ "type": "service_account", ... }', type: 'password' },
    ],
  },

  // ──── Git Repositories ────
  {
    id: 'github', name: 'GitHub', category: 'Version Control', categoryKey: 'git-repo',
    description: 'Push generated automation scripts to GitHub repositories',
    comingSoon: false,
    fields: [
      { key: 'repo_url', label: 'Repository URL', placeholder: 'https://github.com/org/repo' },
      { key: 'branch', label: 'Default Branch', placeholder: 'main' },
      { key: 'access_token', label: 'Access Token', placeholder: 'ghp_...', type: 'password' },
    ],
  },
  {
    id: 'gitlab', name: 'GitLab', category: 'Version Control', categoryKey: 'git-repo',
    description: 'Push automation scripts to GitLab repositories',
    comingSoon: false,
    fields: [
      { key: 'repo_url', label: 'Repository URL', placeholder: 'https://gitlab.com/org/repo' },
      { key: 'branch', label: 'Default Branch', placeholder: 'main' },
      { key: 'access_token', label: 'Personal Access Token', placeholder: 'glpat-...', type: 'password' },
    ],
  },
  {
    id: 'bitbucket', name: 'Bitbucket', category: 'Version Control', categoryKey: 'git-repo',
    description: 'Push automation scripts to Bitbucket repositories',
    comingSoon: false,
    fields: [
      { key: 'repo_url', label: 'Repository URL', placeholder: 'https://bitbucket.org/org/repo' },
      { key: 'branch', label: 'Default Branch', placeholder: 'main' },
      { key: 'username', label: 'Username', placeholder: 'your-username' },
      { key: 'app_password', label: 'App Password', placeholder: 'Bitbucket app password', type: 'password' },
    ],
  },

  // ──── Notifications ────
  {
    id: 'notif-email', name: 'Email (SMTP)', category: 'Email', categoryKey: 'notification',
    description: 'Receive test-run pass/fail notifications by email',
    comingSoon: false,
    fields: [
      { key: 'smtpHost', label: 'SMTP Host', placeholder: 'smtp.gmail.com' },
      { key: 'smtpPort', label: 'SMTP Port', placeholder: '465' },
      { key: 'smtpUser', label: 'SMTP Username / Email', placeholder: 'alerts@company.com' },
      { key: 'smtpPassword', label: 'SMTP Password / App Password', placeholder: '••••••••', type: 'password' },
      { key: 'fromEmail', label: 'From Display Email', placeholder: 'noreply@company.com' },
      { key: 'toEmail', label: 'To (Primary Recipients)', placeholder: 'qa-lead@company.com, ops@company.com' },
      { key: 'ccEmail', label: 'CC (Copy Recipients)', placeholder: 'manager@company.com' },
    ],
  },

  // ──── CI/CD ────
  {
    id: 'jenkins', name: 'Jenkins', category: 'CI/CD', categoryKey: 'git-repo',
    description: 'Trigger test runs from Jenkins pipelines',
    comingSoon: false,
    fields: [
      { key: 'jenkins_url', label: 'Jenkins URL', placeholder: 'https://jenkins.company.com' },
      { key: 'username', label: 'Username', placeholder: 'jenkins-user' },
      { key: 'api_token', label: 'API Token', placeholder: 'Jenkins API token', type: 'password' },
    ],
  },

  // ──── Coming Soon ────
  {
    id: 'postman', name: 'Postman', category: 'API Testing', categoryKey: 'data-source',
    description: 'Import Postman collections for future API test automation',
    comingSoon: true, fields: [],
  },
];

export function getRequirementSources(): CatalogItem[] {
  return INTEGRATION_CATALOG.filter((i) => i.categoryKey === 'requirement-source');
}
export function getDataSources(): CatalogItem[] {
  return INTEGRATION_CATALOG.filter((i) => i.categoryKey === 'data-source');
}
export function getGitRepos(): CatalogItem[] {
  return INTEGRATION_CATALOG.filter((i) => i.categoryKey === 'git-repo');
}
export function getNotifications(): CatalogItem[] {
  return INTEGRATION_CATALOG.filter((i) => i.categoryKey === 'notification');
}
