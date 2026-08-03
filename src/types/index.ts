/**
 * Shared types for the test suite.
 *
 * Add domain types here (e.g. a `User`, `Credentials`, or fixture shapes) and
 * import them from page objects, data files, or specs.
 */

/** A simple credential pair commonly used by auth page objects. */
export interface Credentials {
  username: string;
  password: string;
}
