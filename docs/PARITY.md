# Feature parity with Nova Chrysalia

Goal: open-nova does everything the original (Windows-only) Nova Chrysalia did,
cross-platform. Status: ✅ done + tested · 🟡 partial · ⛔ not started ·
🧑 needs a human/in-game check (can't be verified headlessly) · ➖ N/A.

Validation tiers: **(R)** validated against REAL FFXIII-2 game data pulled from
a Steam Deck; **(V)** validated by DLL-derived vectors or self/round-trip tests.

## Core engine

| Subsystem | Status | Notes |
|---|---|---|
| Filelist cipher (decrypt/encrypt) | ✅ (R) | Decrypts the real `filelistu.win32.bin`, checksum verified. |
| WhiteBin unpack | ✅ (R) | 14,381 real files; bodies decompress byte-exact. |
| WhiteBin repack (full rebuild) | ✅ (V) | Round-trips. |
| WhiteBin selective repack (inject-if-fits) | ✅ (V) | In-place when it fits, append otherwise. |
| WPD container unpack/repack | ✅ (R) | Byte-identical round-trip on a real `.wdb` (WPD). |
| TRB container unpack | ✅ (R) | 46 entries on real `c001.trb`. |
| TRB container repack | ✅ (R) | **Byte-identical** on real `c001.trb` (honours per-resource `fieldC` alignment the original C# got wrong). |
| IMGB/GTEX/DDS texture extract | ✅ (R) | 28 textures from real `c001`; valid DDS. |
| IMGB repack-in-place (no resize) | ✅ (R) | Extract→repack byte-identical on real data. |
| IMGB repack with resize (Repack2) | ✅ (V) | Classic; cubemap/stack throw with a note. |
| WDB game-database ↔ structured | ✅ (R) | Byte-faithful round-trip on real `.wdb`; bit-packed fields decode/encode. strArray (`s#`) re-encode is passthrough (🟡). |
| SCD sound extract | ✅ (R) | Real `SEDBSSCF` fixture → WAV/OGG. Repack ➖ (needs native Vorbis). |
| ZTR text decode/encode | ✅ (V) | BPE + full key dictionaries (cp932/Latin). cp950/cp51949 deferred (🟡). |
| CLB script crypt | ✅ (V) | Decrypt/encrypt via the validated cipher. |
| Save-file crypt | ➖ | XIII-2 saves were disabled in the original too. |
| WMP movie (FMV) container | ⛔ | Niche FMV-replacement format (paired movie-items WDB); structure RE'd, deferred — no real-world XIII-2 mods use it and no fixture to validate. |

## Game integration

| Subsystem | Status | Notes |
|---|---|---|
| Steam discovery (cross-platform) | ✅ (R) | Verified live on the Deck; prefers the SD-card install over the stub. |
| Game unpacker (bulk → unpacked tree) | 🟡 (R) | Generic pair-unpacker + first-time-setup (writes `DebugFontTextureDDS` extracted from the DLL). XIII-2 v1.1 DLC-revert / LR filelist-repair edge-quirks not ported. |
| Launcher: Large-Address-Aware patch | ✅ (R) | On-disk PE patch. |
| Launcher: unpacked-mode patch | ✅ (R) | **Validated on the real `ffxiii2img.exe`** — patches land on the real JZ branch bytes. The gate for mods loading. |
| Launcher: text-language patch | ✅ (V) | All 8 languages, exact bytes. |
| Launcher: debug patch | ✅ (V) | XIII/XIII-2. |
| Launch via Steam/Proton | ✅ | `steam://rungameid`. |
| LR Configuration.ini/Environment.ini | ✅ (V) | |

## Mod management

| Subsystem | Status | Notes |
|---|---|---|
| `.ncmp` import (zip) | ✅ (V) | |
| Install/uninstall (overlay + backup) | ✅ (V) | |
| Enable/disable + load order (deployment ledger) | ✅ (V) | Priority conflict resolution; instant/reversible. *(beyond original)* |
| Mod auto-detection (zero-config) | ✅ (V) | *(beyond original)* |
| Mod generator (`.ncmp`) | ✅ (V) | |
| Texture edit → inject into container | ✅ (R) | CLI `repack-texture` (in-place); validated on real `c001`. Auto-resize-install into ModLibrary is a generator enhancement (🟡). |
| Whole-container texture/db mods | ✅ | Work today via the overlay (mods ship final files). |
| External `.bat`/`.exe` installer mods | 🟡 | Detected + flagged; running them needs a Wine/Proton path. |

## App / distribution

| Subsystem | Status | Notes |
|---|---|---|
| Electron + React + Tailwind UI (5 tabs) | ✅ | Builds, type-checks, runs. |
| CLI (`detect/decrypt/unpack/textures/repack-texture/mods`) | ✅ (R) | |
| Nexus Mods integration (API + `nxm://`) | ✅ (V) | *(beyond original)* |
| Archive extraction (7z/rar) | 🟡 | Dispatcher built; optional WASM deps need a real-archive check. |
| electron-builder packaging (AppImage/Flatpak + `nxm://` reg) | ✅ | Config done; producing the binary is a build step on the user's machine. |
| Standalone GUI editors (filelist/WDB/CLB) | 🟡 | All operations exist programmatically + in the CLI; dedicated GUI editor panels not built. |

## Human-gated / can't verify headlessly

| Item | Status | Notes |
|---|---|---|
| Full on-device unpack → enable mod → **boot in-game** | 🧑 | The unpacked-mode patch is validated against the real exe and the unpacker produces correct files, but actually booting the game (a ~60 GB unpack + a GUI launch) needs a human at the Deck. |
| SCD/movie re-encode in-game playback | 🧑 | |

## Summary

The entire modding-critical path — decrypt, unpack, every common container/asset
format (WhiteBin, WPD, TRB, IMGB textures, WDB databases, SCD, ZTR, CLB),
mod install/enable/disable with conflict resolution, the unpacked-mode launch
patch, Nexus download, and packaging — is implemented and, where game data was
available, **validated against real FFXIII-2 files on a Steam Deck.** Remaining
gaps are: the niche WMP FMV format, the strArray/cp950/cp51949 sub-cases, and
the inherently human-gated final step of booting the modded game.
