import { test } from '../../fixtures';

/**
 * Component Object Model reference — exercises the NavBar component through its
 * fixture. Skipped by default because it assumes the app renders a banner
 * containing a "Home" link; wire `selectors/nav.selectors.ts` to your app's
 * chrome, then remove `.skip`.
 */
test.describe.skip('Navigation bar', () => {
  test('is visible and links home', { tag: '@regression' }, async ({ homePage, navBar }) => {
    await homePage.open();
    await navBar.expectVisible();
    await navBar.goHome();
  });
});
