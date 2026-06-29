import type { SelectorDescriptor } from './types';

/**
 * NAV / global-chrome selector partition — used by the NavBar component.
 *
 * Components route through the central registry exactly like page objects do:
 * no locator strings are hand-written inside the component itself.
 */
export const navSelectors = {
  banner: { role: 'banner' },
  homeLink: { role: 'link', name: 'Home' },
} satisfies Record<string, SelectorDescriptor>;
