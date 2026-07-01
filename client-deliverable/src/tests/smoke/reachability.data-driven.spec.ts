import { test } from '../../fixtures';
import { loadData } from '../../utils/test-data';

/**
 * Data-driven smoke — proves the data-driven pattern end-to-end and runs GREEN
 * against any reachable BASE_URL. Routes are loaded from `data/routes.json`
 * (data separated from logic); add routes there to grow coverage without
 * touching this spec. Each row becomes an independent, atomic test.
 */
const { routes } = loadData<{ routes: string[] }>('routes');

test.describe('Reachability (data-driven)', () => {
  for (const route of routes) {
    test(`route is reachable: ${route}`, { tag: '@smoke' }, async ({ homePage }) => {
      await homePage.goto(route);
      await homePage.expectLoaded();
    });
  }
});
