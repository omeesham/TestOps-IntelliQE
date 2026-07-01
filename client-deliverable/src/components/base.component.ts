import { type Page, type Locator } from '@playwright/test';
import { resolveSelector, type SelectorDescriptor } from '../selectors';

/**
 * BaseComponent — root of the Component Object Model.
 *
 * A component wraps a SECTION of a page (scoped to a `root` Locator) so reusable
 * UI widgets — headers, nav bars, tables, modals — live independently of the
 * pages that host them (SRP + DRY). Like BasePage, it resolves selectors from
 * the central registry; the only difference is that child locators are scoped to
 * the component's `root`.
 */
export abstract class BaseComponent {
  constructor(
    protected readonly page: Page,
    protected readonly root: Locator,
  ) {}

  /** Resolve a SelectorDescriptor from the registry, scoped within this component's root. */
  protected locate(descriptor: SelectorDescriptor): Locator {
    return resolveSelector(this.root, descriptor);
  }
}
