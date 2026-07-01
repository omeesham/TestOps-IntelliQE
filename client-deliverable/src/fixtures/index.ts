import { test as base, expect } from '@playwright/test';
import { HomePage, LoginPage } from '../pages';
import { NavBar } from '../components';
import { AuthFlow } from '../flows';
import { ApiClient, ApiCleanup } from '../api';
import { env } from '../config/env';

/**
 * Custom fixtures — the single place setup/teardown lives, so specs never repeat
 * boilerplate. Each fixture is built per test against that test's ISOLATED
 * browser context, which keeps tests independent and parallel-safe.
 *
 * Adding a page object / component / flow / API client? Declare it in
 * `Fixtures`, register it below, then destructure it in your spec.
 */
type Fixtures = {
  homePage: HomePage;
  loginPage: LoginPage;
  navBar: NavBar;
  authFlow: AuthFlow;
  api: ApiClient;
  apiCleanup: ApiCleanup;
};

export const test = base.extend<Fixtures>({
  homePage: async ({ page }, use) => {
    await use(new HomePage(page));
  },
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  navBar: async ({ page }, use) => {
    await use(new NavBar(page));
  },
  // Flows compose page objects — depend on the page-object fixtures, not on `page`.
  authFlow: async ({ loginPage }, use) => {
    await use(new AuthFlow(loginPage));
  },
  // Playwright's built-in `request` context, wrapped for typed API setup/validation.
  api: async ({ request }, use) => {
    await use(new ApiClient(request, env.API_BASE_URL));
  },
  // Tracks resources created during a test and deletes them after it (teardown
  // runs AFTER use() resolves) — automatic data cleanup, no environment pollution.
  apiCleanup: async ({ api }, use) => {
    const cleanup = new ApiCleanup(api);
    await use(cleanup);
    await cleanup.dispose();
  },
});

export { expect };
