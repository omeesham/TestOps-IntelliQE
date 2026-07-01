import { test } from '../../fixtures';
import { invalidLoginCases } from '../../data/login.data';

/**
 * Data-driven example — one independent, atomic test per data row. Test logic is
 * kept separate from test data (`data/login.data.ts`), so coverage grows by
 * adding rows, not by copy-pasting tests.
 *
 * Skipped by default until the selectors are wired to your application.
 */
test.describe.skip('Login (data-driven)', () => {
  for (const tc of invalidLoginCases) {
    test(`rejects login — ${tc.name}`, { tag: '@regression' }, async ({ authFlow, loginPage }) => {
      await authFlow.login({ username: tc.username, password: tc.password });
      await loginPage.expectLoginError();
    });
  }
});
