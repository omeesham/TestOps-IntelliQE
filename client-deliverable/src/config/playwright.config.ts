import { defineConfig, devices } from '@playwright/test';
import { env } from './env';

/**
 * Playwright configuration — environment-agnostic.
 * All behavior is driven by variables in `.env` (see `.env.example`). Reporting,
 * retries, parallelism, and the target environment change via config only.
 */
export default defineConfig({
  testDir: '../tests',
  fullyParallel: true,
  forbidOnly: env.CI,
  // Retry transient failures in CI; locally default to 0 so flakiness is visible.
  retries: env.RETRIES ?? (env.CI ? 2 : 0),
  workers: env.WORKERS,
  timeout: env.TIMEOUT,
  expect: { timeout: env.EXPECT_TIMEOUT },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../reports/html' }],
    ['junit', { outputFile: '../reports/junit.xml' }],
    ['allure-playwright', { resultsDir: '../reports/allure-results' }],
  ],
  use: {
    baseURL: env.BASE_URL,
    headless: env.HEADLESS,
    // Trace/screenshot/video captured on failure so every failure is debuggable
    // from artifacts without a local re-run.
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
