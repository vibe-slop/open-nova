/**
 * @open-nova/core — cross-platform core library for the FINAL FANTASY XIII
 * trilogy archive + mod format. Open reimplementation of Nova Chrysalia's
 * engine, with no Windows/.NET dependencies.
 */
// Crypto
export * from './crypto/cipher.js';
export * from './crypto/filelist-crypto.js';
// Archive
export * from './archive/binary.js';
export * from './archive/zlib.js';
export * from './archive/filelist.js';
export * from './archive/whitebin.js';
// Game discovery / launch
export * from './game/gameinfo.js';
export * from './game/steam.js';
export * from './game/pe-patch.js';
// Mods
export * from './mods/ini.js';
export * from './mods/ncmp.js';
export * from './mods/manager.js';
export * from './mods/deployment.js';
// Inner container formats
export * from './formats/wpd.js';
export * from './formats/trb.js';

// GameId is declared in both gameinfo.ts and manager.ts (identical union);
// re-export the canonical one to resolve the star-export ambiguity.
export type { GameId } from './game/gameinfo.js';
