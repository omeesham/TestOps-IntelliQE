/**
 * featureCatalog.ts
 * ─────────────────
 * Single source of truth for the toggleable features shown on the Feature
 * Toggles screen and enforced across the app (sidebar, routes, chat).
 *
 * Keys are STABLE strings — never rename one in place (that would silently
 * re-enable a feature a tenant had turned off). A key missing from a tenant's
 * stored map defaults to ENABLED, so adding a feature here is backward-safe.
 */
export interface FeatureDef {
  key: string;
  label: string;
  description: string;
  /** Sidebar/route path this feature maps to (for page-level features). */
  path?: string;
}
export interface FeatureGroup {
  group: string;
  features: FeatureDef[];
}

export const FEATURE_CATALOG: FeatureGroup[] = [
  {
    group: 'Modules',
    features: [
      { key: 'page.chat', label: 'Chat (Tessa)', description: 'The conversational test wizard.', path: '/chat' },
      { key: 'page.dashboard', label: 'Dashboard', description: 'Overview & metrics.', path: '/dashboard' },
      { key: 'page.generatedTests', label: 'Generated Test Cases', description: 'Browse saved test cases.', path: '/generated-tests' },
      { key: 'page.automationScripts', label: 'Automation Scripts', description: 'Generated automation scripts.', path: '/automation-scripts' },
      { key: 'page.reports', label: 'Reports', description: 'Allure execution reports.', path: '/reports' },
      { key: 'page.executionRecordings', label: 'Execution Recordings', description: 'Run video recordings.', path: '/execution-recordings' },
      { key: 'page.agentMonitor', label: 'Agent Monitor', description: 'AI agent status & activity.', path: '/agents' },
      { key: 'page.userManagement', label: 'User Management', description: 'Manage users & roles.', path: '/user-management' },
      { key: 'page.systemConfiguration', label: 'System Configuration', description: 'Integrations & application setup.', path: '/system-configuration' },
    ],
  },
  {
    group: 'Chat — Automation types',
    features: [
      { key: 'chat.webAutomation', label: 'Web Application Automation', description: 'Web / E2E testing in chat.' },
      { key: 'chat.mobileAutomation', label: 'Mobile Application Automation', description: 'APK/IPA mobile testing in chat.' },
      { key: 'chat.apiAutomation', label: 'API Automation', description: 'API testing in chat.' },
    ],
  },
  {
    group: 'Chat — Capabilities',
    features: [
      { key: 'chat.explore', label: 'Explore Application', description: 'Crawl a configured app to infer tests.' },
      { key: 'chat.voice', label: 'Voice Assistant (Tessa TTS)', description: 'Spoken assistant responses in chat.' },
    ],
  },
];

/** Flat list of every feature key. */
export const ALL_FEATURE_KEYS: string[] = FEATURE_CATALOG.flatMap((g) => g.features.map((f) => f.key));

/** Map a sidebar/route path → its feature key (for nav + route gating). */
export const PATH_FEATURE_KEY: Record<string, string> = Object.fromEntries(
  FEATURE_CATALOG.flatMap((g) => g.features.filter((f) => f.path).map((f) => [f.path as string, f.key])),
);
