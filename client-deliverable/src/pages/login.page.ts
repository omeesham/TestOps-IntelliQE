import { type Page, type Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';
import { loginSelectors } from '../selectors';

/**
 * LoginPage — the reference Page Object showing the full pattern:
 *   • locators declared once as `readonly` fields, resolved from the selector
 *     registry in the constructor,
 *   • action methods named for user intent (`login`),
 *   • assertion helpers wrapping web-first expects (`expectLoginError`).
 *
 * A spec talks only to these methods — it never sees a Locator.
 */
export class LoginPage extends BasePage {
  readonly username: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly error: Locator;

  constructor(page: Page) {
    super(page);
    this.username = this.locate(loginSelectors.username);
    this.password = this.locate(loginSelectors.password);
    this.submit = this.locate(loginSelectors.submit);
    this.error = this.locate(loginSelectors.error);
  }

  async open(): Promise<void> {
    await this.goto('/');
  }

  async login(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.submit.click();
  }

  async expectLoginError(): Promise<void> {
    await expect(this.error).toBeVisible();
  }
}
