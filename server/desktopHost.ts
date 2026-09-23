/**
 * Entry point for the server inside the desktop app, where it runs as an
 * Electron utility process (`electron/main.ts`). It starts the same server as
 * `server/index.ts` on the command line and reports to the main process over
 * `process.parentPort`:
 *
 * - out: `{ type: 'ready' }` once listening, or `{ type: 'failed', code, message }`,
 *   after which the main process ends it
 * - in: `{ type: 'status' }` → out: `{ type: 'status', syncing }`
 * - in: `{ type: 'shutdown' }` → closes the database and exits
 *
 * Model training and prediction are synchronous, so a message that arrives
 * during one is answered once it finishes.
 */
import { errorMessage } from '@core/errors';

/** The slice of Electron's `ParentPort` this file uses. */
interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  throw new Error('server/desktopHost runs only as an Electron utility process.');
}

let server: typeof import('./index') | null = null;
let sync: typeof import('./services/sync.service') | null = null;

parentPort.on('message', ({ data }) => {
  const type = (data as { type?: unknown } | null)?.type;
  if (type === 'status') {
    parentPort.postMessage({ type: 'status', syncing: sync?.isSyncRunning() ?? false });
  } else if (type === 'shutdown') {
    server?.shutdown();
    process.exit(0);
  }
});

// Imported dynamically so a failure while loading (opening the database,
// say) is reported like a listen failure rather than ending the process
// silently.
Promise.all([import('./index'), import('./services/sync.service')])
  .then(async ([serverModule, syncModule]) => {
    server = serverModule;
    sync = syncModule;
    await serverModule.serverReady;
  })
  .then(
    () => parentPort.postMessage({ type: 'ready' }),
    // The main process ends this process once it reads the failure; exiting
    // here could drop the message before it is delivered.
    (error: unknown) => {
      parentPort.postMessage({
        type: 'failed',
        code: (error as NodeJS.ErrnoException | undefined)?.code ?? null,
        message: errorMessage(error)
      });
    }
  );
