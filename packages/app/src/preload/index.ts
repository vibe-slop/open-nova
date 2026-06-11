import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type NovaApi } from '../shared/ipc';

const api: NovaApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  setConfig: (patch) => ipcRenderer.invoke(IPC.setConfig, patch),

  detectSteam: () => ipcRenderer.invoke(IPC.detectSteam),
  setGamePath: (game, path) => ipcRenderer.invoke(IPC.setGamePath, game, path),
  browseForFolder: (title) => ipcRenderer.invoke(IPC.browseForFolder, title),
  browseForFile: (title, filters) => ipcRenderer.invoke(IPC.browseForFile, title, filters),

  listMods: (game) => ipcRenderer.invoke(IPC.listMods, game),
  importMod: (ncmpPath) => ipcRenderer.invoke(IPC.importMod, ncmpPath),
  removeMod: (game, name) => ipcRenderer.invoke(IPC.removeMod, game, name),
  installMod: (game, name, opts) => ipcRenderer.invoke(IPC.installMod, game, name, opts),
  uninstallMod: (game, name, opts) => ipcRenderer.invoke(IPC.uninstallMod, game, name, opts),
  generateMod: (spec) => ipcRenderer.invoke(IPC.generateMod, spec),

  decryptFilelist: (inPath, outPath) => ipcRenderer.invoke(IPC.decryptFilelist, inPath, outPath),
  encryptFilelist: (inPath, outPath) => ipcRenderer.invoke(IPC.encryptFilelist, inPath, outPath),
  unpackArchive: (filelistPath, imgPath, outDir, game) => ipcRenderer.invoke(IPC.unpackArchive, filelistPath, imgPath, outDir, game),

  unpackGame: (game) => ipcRenderer.invoke(IPC.unpackGame, game),
  launchGame: (game) => ipcRenderer.invoke(IPC.launchGame, game),

  onProgress: (cb) => {
    const h = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IPC.evProgress, h);
    return () => ipcRenderer.removeListener(IPC.evProgress, h);
  },
  onLog: (cb) => {
    const h = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IPC.evLog, h);
    return () => ipcRenderer.removeListener(IPC.evLog, h);
  },
};

contextBridge.exposeInMainWorld('nova', api);
