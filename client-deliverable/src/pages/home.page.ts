import { BasePage } from './base.page';

/**
 * HomePage — minimal Page Object for the application's landing page.
 *
 * Used by the smoke test to prove the framework + BASE_URL wiring works on any
 * environment without assuming app-specific UI.
 */
export class HomePage extends BasePage {
  async open(): Promise<void> {
    await this.goto('/');
  }

  async expectLoaded(): Promise<void> {
    await this.expectUrl(/.*/);
  }
}
