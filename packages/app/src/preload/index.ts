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

  getNexusAuth: () => ipcRenderer.invoke(IPC.getNexusAuth),
  setNexusApiKey: (key) => ipcRenderer.invoke(IPC.setNexusApiKey, key),
  clearNexusApiKey: () => ipcRenderer.invoke(IPC.clearNexusApiKey),
  openNexusModsPage: (game) => ipcRenderer.invoke(IPC.openNexusModsPage, game),

  libraryList: (game) => ipcRenderer.invoke(IPC.libraryList, game),
  librarySetEnabled: (game, modName, enabled) => ipcRenderer.invoke(IPC.librarySetEnabled, game, modName, enabled),
  librarySetOrder: (game, order) => ipcRenderer.invoke(IPC.librarySetOrder, game, order),
  libraryRemove: (game, modName) => ipcRenderer.invoke(IPC.libraryRemove, game, modName),
  libraryImportFile: (game) => ipcRenderer.invoke(IPC.libraryImportFile, game),
  nexusInstall: (game, modId, fileId) => ipcRenderer.invoke(IPC.nexusInstall, game, modId, fileId),

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
  onNxm: (cb) => {
    const h = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IPC.evNxm, h);
    return () => ipcRenderer.removeListener(IPC.evNxm, h);
  },
};

contextBridge.exposeInMainWorld('nova', api);
