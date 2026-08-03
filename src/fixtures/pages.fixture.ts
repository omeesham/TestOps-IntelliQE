/**
 * Playwright test fixtures.
 *
 * Phase A: a thin re-export so specs share a single import for `test`/`expect`.
 * Specs instantiate page objects directly (`const login = new LoginPage(page)`).
 *
 * Phase B (future): extend `test` with page-object fixtures so specs receive
 * ready-made page objects via dependency injection, e.g.
 *
 *   export const test = base.extend<{ loginPage: LoginPage }>({
 *     loginPage: async ({ page }, use) => { await use(new LoginPage(page)); },
 *   });
 */
export { test, expect } from '@playwright/test';
