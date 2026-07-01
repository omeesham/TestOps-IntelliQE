import { type Page, type Locator, expect } from '@playwright/test';
import { BaseComponent } from './base.component';
import { resolveSelector, navSelectors } from '../selectors';

/**
 * Example component: a primary navigation bar scoped to the page banner.
 *
 * Demonstrates the Component Object Model with the SAME selector-registry
 * discipline as page objects — the root and all child locators come from
 * `navSelectors`, never hand-written selector strings.
 */
export class NavBar extends BaseComponent {
  readonly homeLink: Locator;

  constructor(page: Page) {
    // The root is page-scoped; child locators below are root-scoped via locate().
    super(page, resolveSelector(page, navSelectors.banner));
    this.homeLink = this.locate(navSelectors.homeLink);
  }

  async goHome(): Promise<void> {
    await this.homeLink.click();
  }

  async expectVisible(): Promise<void> {
    await expect(this.root).toBeVisible();
  }
}
