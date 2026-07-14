import type { UserRole } from '@/contexts/AuthContext';

/**
 * Feature catalog — the single source of truth for what can be toggled.
 *
 * Each entry is a feature/permission that can be enabled or disabled per role
 * from the Feature Toggles dashboard. `path` links a feature 1:1 to a route so
 * the sidebar and route guards can gate it automatically.
 *
 * To gate a NEW feature: add an entry here, then either give it a `path`
 * (auto-gated in the sidebar + routes) or wrap the relevant UI in
 * <FeatureGate feature="your-key">…</FeatureGate>.
 *
 * IMPORTANT: the Feature Toggles dashboard itself is intentionally NOT in this
 * catalog, so an admin can never accidentally disable the control panel and
 * lock themselves out.
 */
export interface FeatureDef {
  /** stable key persisted in the DB — never rename once shipped */
  key: string;
  /** human label shown in the dashboard */
  name: string;
  /** short explanation shown in the dashboard */
  description: string;
  /** grouping header in the dashboard */
  group: string;
  /** route path this feature gates, if it maps 1:1 to a page */
  path?: string;
}

export interface RoleDef {
  key: UserRole;
  label: string;
}

export const ROLES: RoleDef[] = [
  { key: 'admin', label: 'Admin' },
  { key: 'qa_engineer', label: 'QA Engineer' },
  { key: 'data_analyst', label: 'Data Analyst' },
];

export const FEATURE_CATALOG: FeatureDef[] = [
  // ── Core pages ────────────────────────────────────────────────
  {
    key: 'chat',
    name: 'Chat / Test Generation',
    description: 'AI chat wizard and the end-to-end test-generation flow.',
    group: 'Core',
    path: '/chat',
  },
  {
    key: 'generated-tests',
    name: 'Generated Test Cases',
    description: 'Browse, edit and manage generated test cases and test runs.',
    group: 'Core',
    path: '/generated-tests',
  },
  {
    key: 'reports',
    name: 'Reports',
    description: 'Execution reports, Allure reports and export history.',
    group: 'Core',
    path: '/reports',
  },
  {
    key: 'bug-tracker',
    name: 'Bug Tracker',
    description: 'Log and manage bugs, severity/priority/status, Azure DevOps push.',
    group: 'Core',
    path: '/bug-tracker',
  },

  // ── Administration ────────────────────────────────────────────
  {
    key: 'user-management',
    name: 'User Management',
    description: 'Create and manage users, roles and tenants.',
    group: 'Administration',
    path: '/user-management',
  },
  {
    key: 'system-configuration',
    name: 'System Configuration',
    description: 'Integrations, data sources, notifications and platform settings.',
    group: 'Administration',
    path: '/system-configuration',
  },
];

/** Fast lookup: route path → feature key (for sidebar + route guards). */
export const PATH_TO_FEATURE: Record<string, string> = FEATURE_CATALOG.reduce(
  (acc, f) => {
    if (f.path) acc[f.path] = f.key;
    return acc;
  },
  {} as Record<string, string>,
);

/** Grouped view for rendering the dashboard. */
export function groupedFeatures(): { group: string; features: FeatureDef[] }[] {
  const order: string[] = [];
  const byGroup: Record<string, FeatureDef[]> = {};
  for (const f of FEATURE_CATALOG) {
    if (!byGroup[f.group]) {
      byGroup[f.group] = [];
      order.push(f.group);
    }
    byGroup[f.group].push(f);
  }
  return order.map((group) => ({ group, features: byGroup[group] }));
}
