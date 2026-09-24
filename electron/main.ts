import { app, BrowserWindow, dialog, ipcMain, session, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '../core/errors';
import { normalizeJamcorderUrl, readConfig, writeConfig } from './config';
import { classifyLibraryFolder, LIBRARY_DB_FILENAME } from './library';

// This file always runs as the bundled dist-electron/main.js (esbuild ESM
// output), so import.meta.url is safe to rely on throughout.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must precede any app.getPath() call: without it, `electron .` in dev
// resolves userData from package.json's lowercase "name" (jamcoda), while
// the packaged build resolves it from productName (JamCoda), splitting the
// data directory in two.
app.setName('JamCoda');

/**
 * Fixed rather than ephemeral: the port is part of the page's origin, and
 * origin-scoped browser storage and cache would reset on every launch
 * otherwise. Distinct from the command-line server's 3001, so the two run
 * side by side.
 */
const SERVER_PORT = 47831;
const APP_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

/**
 * `npm run electron:dev` points the shell at the Vite dev server instead,
 * backed by the command-line server and its repository data. The desktop-only
 * Settings controls act on the desktop app's own data, so dev mode loads no
 * preload and the renderer hides them.
 */
const devUrl = process.env.JAMCODA_ELECTRON_DEV_URL;
const appOrigin = devUrl ? new URL(devUrl).origin : APP_ORIGIN;

const userDataDir = app.getPath('userData');

const defaultLibraryDir = path.join(userDataDir, 'data');

/** The library folder in use; see `JamcodaConfig.libraryDir`. */
function currentLibraryDir(): string {
  return readConfig(userDataDir).libraryDir ?? defaultLibraryDir;
}

/**
 * The server runs in a utility process, not in this one: model training and
 * prediction are synchronous and would otherwise stall the main process, and
 * with it every window, for as long as they run. `server/desktopHost.ts`
 * describes the messages.
 */
let serverProcess: UtilityProcess | null = null;
let serving = false;
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;

type HostMessage =
  | { type: 'ready' }
  | { type: 'failed'; code: string | null; message: string }
  | { type: 'status'; syncing: boolean };

class ServerStartError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
  }
}

function startServer(): Promise<void> {
  const config = readConfig(userDataDir);
  const libraryDir = config.libraryDir ?? defaultLibraryDir;
  // The child cannot start in a folder that does not exist. Only the default
  // library is created here; a configured one that is missing never reaches
  // this point (`startServerWithRecovery`).
  if (!config.libraryDir) mkdirSync(defaultLibraryDir, { recursive: true });
  const child = utilityProcess.fork(path.join(__dirname, 'server.cjs'), [], {
    serviceName: 'JamCoda server',
    // Everything the server reads or writes is resolved against the
    // database's folder, not the working directory; running there anyway
    // keeps any stray relative path inside the library.
    cwd: libraryDir,
    env: {
      ...process.env,
      JAMCODA_DB_PATH: path.join(libraryDir, LIBRARY_DB_FILENAME),
      JAMCORDER_URL: config.jamcorderUrl,
      JAMCODA_CLIENT_DIST_DIR: path.join(__dirname, '..', 'dist'),
      JAMCODA_SERVER_PORT: String(SERVER_PORT),
      JAMCODA_LOOPBACK_ONLY: '1'
    }
  });
  serverProcess = child;

  child.on('exit', (code) => {
    if (serverProcess !== child) return;
    serverProcess = null;
    if (serving && !isQuitting) {
      dialog.showErrorBox('JamCoda stopped', `The JamCoda server exited unexpectedly (code ${code}). The app will close.`);
      app.exit(1);
    }
  });

  return new Promise((resolve, reject) => {
    const onMessage = (message: HostMessage) => {
      if (message.type === 'ready') {
        child.off('message', onMessage);
        child.off('exit', onExit);
        serving = true;
        resolve();
      } else if (message.type === 'failed') {
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.kill();
        reject(new ServerStartError(message.message, message.code));
      }
    };
    const onExit = (code: number) => {
      child.off('message', onMessage);
      reject(new ServerStartError(`The server exited during startup (code ${code}).`, null));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

/**
 * Why the server should not be restarted right now, or null when it can be.
 * A server that does not answer within two seconds is treated as busy:
 * model training and prediction are synchronous and hold its event loop
 * until they finish, and a relaunch would kill them partway through.
 */
function restartBlocker(): Promise<string | null> {
  const child = serverProcess;
  if (!child) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      resolve('JamCoda is busy; a model rebuild or prediction may be running.');
    }, 2000);
    const onMessage = (message: HostMessage) => {
      if (message.type !== 'status') return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message.syncing ? 'A sync is running.' : null);
    };
    child.on('message', onMessage);
    child.postMessage({ type: 'status' });
  });
}

/**
 * Ask the server to close its database and exit, and wait for it. A server
 * busy training answers only when training ends, so after a grace period it
 * is killed; SQLite recovers an interrupted write from its journal.
 */
function stopServer(): Promise<void> {
  const child = serverProcess;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage({ type: 'shutdown' });
  });
}

function isAppUrl(url: string): boolean {
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

function openExternally(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url);
  } catch {
    // Not a URL; nothing to open.
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: devUrl ? undefined : path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Links leave the app for the system browser; nothing opens a second
  // Electron window, which would inherit the preload bridge.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  void win.loadURL(devUrl ?? `${APP_ORIGIN}/`);
}

function focusMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/** IPC is answered only for the app's own top-level page. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && isAppUrl(frame.url);
}

function registerIpc(): void {
  ipcMain.handle('jamcoda:set-jamcorder-url', async (event, input: unknown) => {
    if (!fromApp(event)) throw new Error('Rejected IPC from an untrusted frame.');
    const url = typeof input === 'string' ? normalizeJamcorderUrl(input) : null;
    if (!url) {
      return { ok: false, error: 'Enter a host name, IP address, or http(s) address, like jamcorder.local.' };
    }
    // The server reads the address once, at startup, so saving relaunches.
    const blocker = await restartBlocker();
    if (blocker) return { ok: false, error: `${blocker} Save again once it finishes.` };
    writeConfig(userDataDir, { ...readConfig(userDataDir), jamcorderUrl: url });
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('jamcoda:reveal-data-folder', (event) => {
    if (!fromApp(event)) throw new Error('Rejected IPC from an untrusted frame.');
    shell.showItemInFolder(currentLibraryDir());
  });

  ipcMain.handle('jamcoda:choose-library-folder', async (event) => {
    if (!fromApp(event)) throw new Error('Rejected IPC from an untrusted frame.');
    // Switching relaunches the app.
    const blocker = await restartBlocker();
    if (blocker) return { ok: false, error: `${blocker} Try again once it finishes.` };
    const picked = await pickLibraryFolder();
    if (picked.kind === 'canceled') return { ok: false, error: null };
    if (picked.kind === 'refused') return { ok: false, error: picked.error };
    if (path.resolve(picked.dir) === path.resolve(currentLibraryDir())) {
      return { ok: false, error: 'That is already the library in use.' };
    }
    useLibrary(picked.dir);
    app.relaunch();
    app.quit();
    return { ok: true };
  });
}

type PickedLibrary =
  | { kind: 'canceled' }
  | { kind: 'refused'; error: string }
  | { kind: 'picked'; dir: string };

/**
 * Asks for a library folder: one holding `jamcoda.db`, or an empty one for a
 * new library. A folder holding anything else is refused rather than filled.
 */
async function pickLibraryFolder(): Promise<PickedLibrary> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a JamCoda library folder',
    message: `Choose the folder that contains ${LIBRARY_DB_FILENAME}, or an empty folder for a new library.`,
    buttonLabel: 'Use Folder',
    properties: ['openDirectory', 'createDirectory']
  };
  const picked = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const dir = picked.filePaths[0];
  if (picked.canceled || !dir) return { kind: 'canceled' };
  if (classifyLibraryFolder(dir) === 'other') {
    return {
      kind: 'refused',
      error: `That folder has no ${LIBRARY_DB_FILENAME} and is not empty. Choose the folder that contains ${LIBRARY_DB_FILENAME}, or an empty folder.`
    };
  }
  return { kind: 'picked', dir };
}

/** Saves the library folder; the default one is stored as no setting at all. */
function useLibrary(dir: string | null): void {
  const { libraryDir: _previous, ...rest } = readConfig(userDataDir);
  const isDefault = dir === null || path.resolve(dir) === path.resolve(defaultLibraryDir);
  writeConfig(userDataDir, isDefault ? rest : { ...rest, libraryDir: dir });
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Starts the server on the configured library, and when that fails, asks the
 * user whether to choose another library, go back to the default one, or
 * quit. A configured library that is missing (an unplugged drive, say) is
 * treated as a failure, never quietly replaced by a new empty one. Returns
 * false when the app should quit.
 */
async function startServerWithRecovery(): Promise<boolean> {
  for (;;) {
    const configured = readConfig(userDataDir).libraryDir;
    let problem: string | null = null;
    if (configured && !isDirectory(configured)) {
      problem = `The library folder ${configured} could not be found. If it is on an external or network drive, connect it and open JamCoda again.`;
    } else {
      try {
        await startServer();
        return true;
      } catch (error) {
        if (error instanceof ServerStartError && error.code === 'EADDRINUSE') {
          dialog.showErrorBox(
            'JamCoda could not start',
            `Port ${SERVER_PORT} on this computer is already in use by another program. Close it and open JamCoda again.`
          );
          return false;
        }
        problem = `The library at ${configured ?? defaultLibraryDir} could not be opened.\n\n${errorMessage(error)}`;
      }
    }

    const buttons = configured
      ? ['Choose Library Folder…', 'Use Default Library', 'Quit']
      : ['Choose Library Folder…', 'Quit'];
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: 'JamCoda could not open its library',
      detail: problem,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1
    });
    const choice = buttons[response];
    if (choice === 'Quit') return false;
    if (choice === 'Use Default Library') {
      useLibrary(null);
      continue;
    }
    const picked = await pickLibraryFolder();
    if (picked.kind === 'refused') {
      await dialog.showMessageBox({ type: 'warning', message: picked.error });
    } else if (picked.kind === 'picked') {
      useLibrary(picked.dir);
    }
  }
}

async function main(): Promise<void> {
  // One instance per user: a second one would open the same database and
  // find the port taken. A second launch focuses the first instead.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Both events can arrive while the server is still starting; the window
  // opens once it is listening.
  const showWhenServing = () => {
    if (app.isReady() && (devUrl || serving)) focusMainWindow();
  };
  app.on('second-instance', showWhenServing);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', showWhenServing);
  app.on('before-quit', (event) => {
    if (!serverProcess) return;
    // Hold the quit until the server has closed its database.
    event.preventDefault();
    if (isQuitting) return;
    isQuitting = true;
    void stopServer().then(() => app.quit());
  });

  await app.whenReady();

  // The app uses no permission-gated web API; refuse them all.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  registerIpc();

  if (!devUrl && !(await startServerWithRecovery())) {
    app.exit(1);
    return;
  }

  createWindow();
}

void main();
