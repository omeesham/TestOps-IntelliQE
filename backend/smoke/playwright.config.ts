/**
 * Smoke suite for IntelliQE itself (not for applications under test).
 * Runs against a running deployment:
 *   SMOKE_BASE_URL=http://localhost:8089 SMOKE_USER=... SMOKE_PASSWORD=... npm run smoke
 * Browser: PLAYWRIGHT_CHANNEL (default msedge locally; use chromium on Linux/CI).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.smoke.spec.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'smoke-report', open: 'never' }]],
  outputDir: 'smoke-results',
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'http://localhost:8089',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
