// Electron's preload-loading is version-sensitive about ESM preload scripts,
// so this is built to `dist-electron/preload.cjs` (CommonJS) -- the one
// deliberate exception to this repo's all-ESM convention. See
// scripts/buildElectron.ts.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jamcoda', {
  setJamcorderUrl: (url: string) => ipcRenderer.invoke('jamcoda:set-jamcorder-url', url),
  revealDataFolder: () => ipcRenderer.invoke('jamcoda:reveal-data-folder')
});
