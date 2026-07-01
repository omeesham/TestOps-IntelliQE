import { test } from '../../fixtures';
import { invalidCredentials } from '../../data/login.data';

/**
 * Reference example of the layered architecture in action:
 * spec (what) → AuthFlow business layer (reusable journey) → LoginPage (how).
 * The test body never touches a Locator or `page.*`.
 *
 * Skipped by default until `src/selectors/login.selectors.ts` is pointed at your
 * application's fields — then remove `.skip`.
 */
test.describe.skip('Login', () => {
  test('rejects invalid credentials', { tag: '@regression' }, async ({ authFlow, loginPage }) => {
    await authFlow.login(invalidCredentials);
    await loginPage.expectLoginError();
  });
});
