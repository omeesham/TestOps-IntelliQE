/**
 * Central selector registry (barrel).
 *
 * Every selector partition and the shared resolver are re-exported here so page
 * objects and components import from `../selectors` and never reach into
 * individual files.
 */
export type { AriaRole, SelectorDescriptor } from './types';
export * from './resolve';
export * from './login.selectors';
export * from './nav.selectors';
