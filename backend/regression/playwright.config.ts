/**
 * Regression suite for IntelliQE itself: proves that existing functionality
 * still works after a change. Runs against a running build (dev mode):
 *
 *   REG_BASE_URL=http://localhost:5173 REG_API_URL=http://localhost:3001 \
 *   REG_USER=... REG_PASSWORD=... npm run regression
 *
 * The backend must point its AI calls at the fake AI server in this folder
 * (ANTHROPIC_API_KEY=regression ANTHROPIC_BASE_URL=http://localhost:4599),
 * so runs are fast, free and repeatable. See README.md.
 * Browser: PLAYWRIGHT_CHANNEL (default msedge locally; use chromium on Linux/CI).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.regression.spec.ts',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'regression-report', open: 'never' }]],
  outputDir: 'regression-results',
  use: {
    baseURL: process.env.REG_BASE_URL || 'http://localhost:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    launchOptions: { args: ['--mute-audio'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
