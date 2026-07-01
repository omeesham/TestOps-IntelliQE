import type { Page } from '@playwright/test';

/** The ARIA role union accepted by Playwright's getByRole. */
export type AriaRole = Parameters<Page['getByRole']>[0];

/**
 * A selector descriptor — the single, accessibility-first way this framework
 * names a UI element. Page objects resolve these into Locators via
 * `BasePage.locate()`; specs and page-object methods never hand-write a raw
 * selector string.
 *
 * Prefer stable handles: `role` + accessible `name`, `label`, or `testId`
 * (data-testid). Avoid brittle CSS/XPath tied to layout or styling.
 */
export type SelectorDescriptor =
  | { role: AriaRole; name?: string | RegExp; exact?: boolean }
  | { label: string | RegExp; exact?: boolean }
  | { placeholder: string | RegExp; exact?: boolean }
  | { text: string | RegExp; exact?: boolean }
  | { testId: string };
