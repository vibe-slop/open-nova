# Feature parity with Nova Chrysalia

Goal: open-nova should do everything the original (Windows-only) Nova Chrysalia
did, cross-platform. This tracks each subsystem. Status legend: ✅ done +
tested · 🟡 partial · ⛔ not started.

## Core engine

| Subsystem | Status | Notes |
|---|---|---|
| Filelist cipher (decrypt/encrypt) | ✅ | Byte-validated vs DLL **and a real FFXIII-2 filelist** (checksum verified). |
| WhiteBin archive **unpack** | ✅ | Validated on real `white_imgu` (14,381 files; bodies decompress byte-exact). |
| WhiteBin archive **repack** (full rebuild) | ✅ | Round-trips; needs a real repack→in-game check. |
| WhiteBin **selective repack** (inject-if-fits) | 🟡 | Full rebuild works; in-place inject optimization not ported. |
| WPD container unpack/repack | ✅ | Reader validated on real `c001`. |
| TRB container unpack | ✅ | Validated on real `c001.trb` (46 entries). |
| TRB container **repack** | 🟡 | Partial; full SEDBRES rebuild pending. |
| IMGB/GTEX/DDS **texture extract** | ✅ | Validated on real `c001` (28 textures, valid DDS). |
| IMGB **repack-in-place** (no resize) | ✅ | Extract→repack byte-identical on real data. |
| IMGB **repack with resize** (Repack2) | ⛔ | Needed for HD packs that change dimensions. |
| ZTR text (extract/convert, key dicts) | ⛔ | Text mods. Needs codepage support (iconv-lite). |
| SCD sound container | ⛔ | Needs oggenc/Vorbis. |
| WMP movie container | ⛔ | |
| WDB game database (↔ JSON/Excel) | ⛔ | The SQLite/EntityFramework tool. |
| CLB script crypt | 🟡 | Cipher engine handles it; no editor/round-trip wired. |
| Save-file crypt | ⛔ | XIII-2 saves were disabled in original too. |

## Game integration

| Subsystem | Status | Notes |
|---|---|---|
| Steam discovery (cross-platform) | ✅ | Registry → dir probing + `libraryfolders.vdf`. Prefers data-root install over stub. Verified live on Deck. |
| Game unpacker (bulk → unpacked tree) | 🟡 | Generic pair-unpacker built; missing per-game first-time-setup (DebugFontTextureDDS, XIII-2 v1.1 DLC revert, LR filelist repair) — these need embedded resources extracted from the DLL. |
| Launcher: Large-Address-Aware patch | ✅ | On-disk PE patch. |
| Launcher: **unpacked-mode** patch | ✅ | Memory→on-disk PE patch. **Validated against real `ffxiii2img.exe`** (patches land on the real JZ branch bytes). The gate for mods loading. |
| Launcher: text-language patch | ✅ | All 8 languages, exact bytes from source; structurally validated (not yet in-game). |
| Launcher: debug patch | ✅ | XIII/XIII-2 (LR n/a). |
| Launch via Steam/Proton (`steam://`) | ✅ | |
| LR Configuration.ini/Environment.ini | 🟡 | Settings model exists; LR config writer pending. |

## Mod management

| Subsystem | Status | Notes |
|---|---|---|
| `.ncmp` import (zip) | ✅ | Hand-rolled zip (store+deflate). |
| Mod install/uninstall (overlay + backup) | ✅ | |
| **Enable/disable + load order** (deployment ledger) | ✅ | Priority conflict resolution; reorder is instant/reversible. *(beyond original — original was install/uninstall only)* |
| Mod auto-detection (zero-config) | ✅ | ncmp/dataRoot/bare/installer. *(beyond original)* |
| Mod generator (`.ncmp`) | ✅ | |
| **In-container texture-mod install** (DDS → repack into WPD/TRB) | ⛔ | Tooling exists; the install-time wiring is next. The HD-pack case. |
| External `.bat`/`.exe` installer mods | 🟡 | Detected + flagged; running them needs a Wine/Proton path. |
| WPD-container repack during install (`!!WPD_Records.txt`) | ⛔ | |

## App / distribution (open-nova additions)

| Subsystem | Status | Notes |
|---|---|---|
| Electron + React + Tailwind UI (5 tabs) | ✅ | Builds, type-checks, runs. |
| CLI (`detect/decrypt/unpack/textures/mods`) | ✅ | |
| **Nexus Mods integration** (API + `nxm://`) | ✅ | *(beyond original — Nova had no Nexus integration.)* |
| Archive extraction (7z/rar) | 🟡 | Dispatcher built; WASM deps optional, need a real-archive check. |
| electron-builder packaging (AppImage/Flatpak + `nxm://` registration) | ⛔ | Required for the Deck. |
| ZTR/WDB/save standalone editors | ⛔ | |

## Priority order to "everything"

1. **In-container texture-mod install** (Tier B) — makes HD/texture packs apply. *(tooling done; wire it)*
2. **Game unpacker first-time-setup quirks** + a full on-device unpack→launch test (unpacked-mode patch is ready).
3. **ZTR text** — common text mods.
4. **electron-builder packaging** — `nxm://` on the Deck + installable build.
5. TRB full repack, IMGB resize repack, selective repack.
6. **WDB / SCD / WMP** and the standalone editors.
