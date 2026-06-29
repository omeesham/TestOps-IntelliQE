import type { SelectorDescriptor } from './types';

/**
 * LOGIN module selector partition.
 *
 * Add one partition file per feature/module (e.g. `dashboard.selectors.ts`) and
 * re-export it from `./index`. Keeping every locator key here — never inline in
 * a page object or spec — is what makes selectors easy to audit and update when
 * the UI changes.
 */
export const loginSelectors = {
  username: { placeholder: 'Username' },
  password: { placeholder: 'Password' },
  submit: { role: 'button', name: 'Login' },
  error: { text: 'Invalid credentials' },
} satisfies Record<string, SelectorDescriptor>;
