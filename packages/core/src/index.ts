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
export * from './archive/whitebin-selective.js';
export * from './archive/extract.js';
// Game discovery / launch
export * from './game/gameinfo.js';
export * from './game/steam.js';
export * from './game/pe-patch.js';
export * from './game/launcher.js';
// Mods
export * from './mods/ini.js';
export * from './mods/ncmp.js';
export * from './mods/manager.js';
export * from './mods/deployment.js';
export * from './mods/autodetect.js';
export * from './mods/library.js';
// Nexus Mods integration
export * from './nexus/types.js';
export * from './nexus/nxm.js';
export * from './nexus/client.js';
// Inner container formats
export * from './formats/wpd.js';
export * from './formats/trb.js';
export { repackTrb } from './formats/trb-repack.js';
export * from './formats/ztr.js';
export * from './formats/ztr-dicts.js';
// Texture pipeline (GTEX header + DDS + IMGB pixel blob)
export * from './formats/gtex.js';
export * from './formats/dds.js';
export * from './formats/imgb.js';
export * from './formats/imgb-repack2.js';
export * from './formats/wdb.js';
export * from './formats/scd.js';

// GameId is declared in both gameinfo.ts and manager.ts (identical union);
// re-export the canonical one to resolve the star-export ambiguity.
export type { GameId } from './game/gameinfo.js';
