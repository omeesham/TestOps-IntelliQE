/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build version stamp, e.g. "V42-150626" (V<build>-DDMMYY). Injected at build time. */
  readonly VITE_APP_VERSION?: string;
  /**
   * Optional override for the Microsoft SSO start URL. Normally unset: the
   * login page discovers SSO from GET /api/auth/sso/providers and uses the
   * same-origin default (/api/auth/sso/microsoft).
   */
  readonly VITE_MS_SSO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
