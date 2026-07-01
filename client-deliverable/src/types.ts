/**
 * Shared framework types. Keep cross-layer types here so they are defined once
 * (DRY) and imported by both the business layer and the data layer.
 */

/** Login credentials used by AuthFlow and the login data sets. */
export interface Credentials {
  username: string;
  password: string;
}
