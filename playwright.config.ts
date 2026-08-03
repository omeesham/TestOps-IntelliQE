import { defineConfig, devices } from '@playwright/test';
import { env } from './src/utils/env';

/**
 * Playwright configuration — environment-agnostic, POM layout.
 * All behavior is driven by variables in `.env` (see `.env.example`).
 * Tests live in `tests/` (incl. module subfolders); page objects in `src/pages/`.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: env.CI,
  retries: env.CI ? 2 : 0,
  workers: env.WORKERS,
  timeout: env.TIMEOUT,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './reports/html' }],
    ['junit', { outputFile: './reports/junit.xml' }],
  ],
  use: {
    baseURL: env.BASE_URL,
    headless: env.HEADLESS,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
