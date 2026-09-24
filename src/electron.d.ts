export {};

declare global {
  interface Window {
    /**
     * The desktop app's bridge, exposed by `electron/preload.ts`. Undefined in
     * a browser and under `npm run electron:dev`.
     */
    jamcoda?: {
      /** Saves the address and relaunches the app, or reports why it was refused. */
      setJamcorderUrl: (url: string) => Promise<{ ok: true } | { ok: false; error: string }>;
      revealDataFolder: () => Promise<void>;
      /**
       * Asks for a library folder (one holding `jamcoda.db`, or an empty one
       * for a new library) and relaunches on it. Nothing is copied. `error` is
       * null when the user canceled.
       */
      chooseLibraryFolder: () => Promise<{ ok: true } | { ok: false; error: string | null }>;
    };
  }
}
