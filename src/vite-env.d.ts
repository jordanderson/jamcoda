/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Jamcorder device. Exposed via `envPrefix` in vite.config.ts. */
  readonly JAMCORDER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
