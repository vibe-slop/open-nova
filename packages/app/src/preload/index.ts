import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type NovaApi } from '../shared/ipc';

const api: NovaApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  setConfig: (patch) => ipcRenderer.invoke(IPC.setConfig, patch),

  detectSteam: () => ipcRenderer.invoke(IPC.detectSteam),
  setGamePath: (game, path) => ipcRenderer.invoke(IPC.setGamePath, game, path),
  browseForFolder: (title) => ipcRenderer.invoke(IPC.browseForFolder, title),

  getUnpackPlan: (game) => ipcRenderer.invoke(IPC.unpackPlan, game),
  unpackGame: (game, force) => ipcRenderer.invoke(IPC.unpackGame, game, force),
  launchGame: (game) => ipcRenderer.invoke(IPC.launchGame, game),

  libraryList: (game) => ipcRenderer.invoke(IPC.libraryList, game),
  librarySetEnabled: (game, modName, enabled) => ipcRenderer.invoke(IPC.librarySetEnabled, game, modName, enabled),
  librarySetOrder: (game, order) => ipcRenderer.invoke(IPC.librarySetOrder, game, order),
  libraryRemove: (game, modName) => ipcRenderer.invoke(IPC.libraryRemove, game, modName),
  libraryImportFile: (game) => ipcRenderer.invoke(IPC.libraryImportFile, game),

  onProgress: (cb) => {
    const h = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IPC.evProgress, h);
    return () => ipcRenderer.removeListener(IPC.evProgress, h);
  },
};

contextBridge.exposeInMainWorld('nova', api);
