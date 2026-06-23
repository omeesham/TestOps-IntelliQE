/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build version stamp, e.g. "V42-150626" (V<build>-DDMMYY). Injected at build time. */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
