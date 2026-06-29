import { test, expect } from '../../fixtures';
import { makeUser } from '../../utils/data-factory';

/**
 * Combined API + UI validation with automatic data cleanup (reference template).
 *
 * Pattern (test pyramid in practice): create the data the UI test needs via the
 * API — fast and reliable — exercise the real user journey through the UI, then
 * let the `apiCleanup` fixture delete the data at teardown so nothing is left
 * behind. Skipped by default; point API_BASE_URL + the endpoints at your app and
 * remove `.skip` to enable.
 */
test.describe.skip('Login with API-seeded user', () => {
  test(
    'a user created via API can log in through the UI',
    { tag: ['@integration', '@regression'] },
    async ({ api, apiCleanup, authFlow, loginPage }) => {
      // Arrange — create a unique user via the API (push setup below the UI).
      const user = makeUser();
      const res = await api.post('/users', user);
      expect(res.ok()).toBeTruthy();
      const created = (await res.json()) as { id: string };
      apiCleanup.track(`/users/${created.id}`); // auto-deleted at test teardown

      // Act + Assert — validate the genuine login journey through the UI.
      await authFlow.login({ username: user.username, password: user.password });
      await loginPage.expectUrl(/.*/);
    },
  );
});
