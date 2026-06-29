import { test } from '../../fixtures';

/**
 * Smoke suite — fast checks that prove the framework, BASE_URL, and POM wiring
 * work end-to-end. Tagged @smoke so CI can run it as a quick gate
 * (`npm run test:smoke`). Routes through a Page Object — no raw `page.*`.
 */
test.describe('Smoke', () => {
  test('application base URL is reachable', { tag: '@smoke' }, async ({ homePage }) => {
    await homePage.open();
    await homePage.expectLoaded();
  });
});
