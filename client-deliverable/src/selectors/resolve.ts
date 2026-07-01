import { type Page, type Locator } from '@playwright/test';
import type { SelectorDescriptor } from './types';

/**
 * Resolve a SelectorDescriptor into a Playwright Locator within a scope.
 *
 * The scope is a `Page` (for top-level page objects) or a parent `Locator` (for
 * components scoped to a root element). Defining the resolution ONCE here keeps
 * BasePage and BaseComponent free of duplicated locator-building logic (DRY).
 */
export function resolveSelector(scope: Page | Locator, descriptor: SelectorDescriptor): Locator {
  if ('role' in descriptor) {
    return scope.getByRole(descriptor.role, { name: descriptor.name, exact: descriptor.exact });
  }
  if ('label' in descriptor) {
    return scope.getByLabel(descriptor.label, { exact: descriptor.exact });
  }
  if ('placeholder' in descriptor) {
    return scope.getByPlaceholder(descriptor.placeholder, { exact: descriptor.exact });
  }
  if ('text' in descriptor) {
    return scope.getByText(descriptor.text, { exact: descriptor.exact });
  }
  return scope.getByTestId(descriptor.testId);
}
