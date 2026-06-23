/**
 * Demo queue data for the Agent Monitor page when no live runs are present.
 * Real pipeline run data comes from the API at runtime.
 */
import type { QueueItem } from '@/types';

export const mockQueue: QueueItem[] = [
  {
    id: 'Q-001',
    feature: 'Login',
    module: 'auth',
    stage: 'completed',
    priority: 'P0',
    lockedBy: null,
    intent: 'Create E2E login tests with valid/invalid credentials',
    artifacts: {
      testCaseFile: 'specs_planning/test-cases/auth_login.md',
      testPlanFile: 'specs_planning/test-plans/auth_login_plan.md',
      specFiles: ['tests/specs/auth/auth_login.spec.ts'],
    },
    history: [
      { agent: 'requirements', action: 'Explored live UI, captured login flows', timestamp: '—' },
      { agent: 'planner',      action: 'Created 8 test cases',                   timestamp: '—' },
      { agent: 'generator',    action: 'Generated auth_login.spec.ts',           timestamp: '—' },
      { agent: 'audit',        action: 'Audit passed',                           timestamp: '—' },
    ],
    totalTcCount: 8,
    automatableCount: 8,
  },
];
