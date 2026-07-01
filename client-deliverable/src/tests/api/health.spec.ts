import { test, expect } from '../../fixtures';

/**
 * API + UI validation together: this suite checks the backend directly via the
 * API layer (no browser), giving faster feedback and better root-cause
 * isolation than UI-only coverage.
 *
 * Skipped by default — set API_BASE_URL and point the path at your health
 * endpoint, then remove `.skip`.
 */
test.describe.skip('API health', () => {
  test('health endpoint returns ok', { tag: '@api' }, async ({ api }) => {
    // getAndAssertOk performs the 2xx web-first assertion (no duplicated ok-check).
    const res = await api.getAndAssertOk('/health');
    expect(res.status()).toBeLessThan(300);
  });
});
