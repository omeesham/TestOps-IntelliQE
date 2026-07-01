import { type Page, type Locator, expect } from '@playwright/test';
import { resolveSelector, type SelectorDescriptor } from '../selectors';
import { logger } from '../utils/logger';

/**
 * BasePage — the shared foundation every Page Object extends.
 *
 * It owns the Playwright `page`, resolves selector descriptors from the registry
 * into Locators (via the shared resolver), and provides common
 * navigation/assertion helpers — so individual page objects stay small and free
 * of duplicated plumbing.
 */
export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  /** Resolve a SelectorDescriptor from the registry into a page-scoped Locator. */
  protected locate(descriptor: SelectorDescriptor): Locator {
    return resolveSelector(this.page, descriptor);
  }

  /** Navigate to a path relative to the configured BASE_URL. */
  async goto(path = '/'): Promise<void> {
    logger.debug(`Navigating to ${path}`);
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
  }

  /** Web-first URL assertion (auto-waits and auto-retries). */
  async expectUrl(pattern: RegExp): Promise<void> {
    await expect(this.page).toHaveURL(pattern);
  }
}
