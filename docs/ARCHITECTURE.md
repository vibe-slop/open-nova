# open-nova — Architecture & Port Plan

A cross-platform (Linux / Steam Deck / macOS / Windows), open-source
reimplementation of Nova Chrysalia for the FINAL FANTASY XIII trilogy.

## Stack

- **`@open-nova/core`** — a pure-TypeScript library (Node `Buffer`/`fs`/`zlib`/
  `crypto` only, no native addons). All format logic: crypto, WhiteBin
  unpack/repack, WPD/TRB/IMGB, mod install/uninstall, Steam discovery, PE patch.
  Usable headless (CLI) and from the Electron main process.
- **`@open-nova/cli`** — a thin command wrapper (archive tools, unpack, mod
  install) for power users and Steam Deck terminals.
- **`@open-nova/app`** — Electron. **Main process** holds all `core` logic and
  long-running jobs; **renderer** (React + Vite) is the 5-tab UI. They talk over
  typed IPC; jobs stream progress events to a progress bar.

Why Electron and not native: the original is a WPF GUI; Electron gives us one UI
codebase across Deck/desktop, trivial packaging (AppImage/Flatpak for the Deck),
and lets 100% of the engine be plain TypeScript. The renderer never touches the
filesystem — everything goes through IPC to `core`.

## Module map (`@open-nova/core`)

```
crypto/
  cipher.ts            ✅ DONE — block cipher + key schedule (validated vs DLL)
  filelist-crypto.ts   ✅ DONE — filelist header/tag framing (needs real-file test)
archive/
  filelist.ts          ▢ parse/build the index (header, entries, chunks)
  whitebin.ts          ▢ unpack/repack white_img (full + selective inject)
  zlib.ts              ▢ thin wrapper: RFC1950, level 9
formats/
  wpd.ts  trb.ts        ▢ container bundles (texture header blocks)
  imgb.ts  dds.ts       ▢ texture extract/repack
  ztr.ts                ▢ text (codepages via iconv-lite) — later
  ini.ts                ▢ modconfig.ini (preserve quirks)
game/
  steam.ts             ▢ cross-platform Steam/Proton library discovery
  gameinfo.ts          ▢ the 3-game constant table (appids/paths/exes)
  unpacker.ts          ▢ bulk extract → unpacked tree
  launcher.ts          ▢ PE on-disk patch + steam://rungameid launch
mods/
  ncmp.ts              ▢ zip pack/unpack
  manager.ts           ▢ install/uninstall (overlay + backup), generate
```

## Windows-dependency inventory (what blocks a naive port, and the fix)

| Original dependency | Severity | Port strategy |
|---|---|---|
| Custom filelist cipher + unrecovered S-box | **was hard** | ✅ Solved: S-box = `(i+120)%256`; cipher ported & validated |
| WPF UI (Window, XAML, MessageBox, Dispatcher, DataGrid) | hard | Rebuild as Electron renderer; IPC replaces Dispatcher |
| Windows registry (Steam root, active user, "Running") | hard | Probe platform Steam dirs; parse `libraryfolders.vdf`/`loginusers.vdf`; detect running game by process name |
| **Process-memory patching** of the running exe (`WriteProcessMemory`, suspend/resume) for unpacked-mode/lang/debug | **hard** | Patch the **on-disk PE** before launch (same byte edits, RVA→file-offset via section table), restore from `.original`; launch via `steam://rungameid/<appid>` |
| Large-Address-Aware PE bit patch | easy | fs+Buffer: e_lfanew@0x3C → pe+22 → set flag 0x20 |
| Win32 INI APIs | easy | JS INI lib; keep leading-space-write + `NovaChysaliaConfig` misspelling |
| `Gameloop.Vdf` | easy | `@node-steam/vdf` (read each numeric entry's `path`) |
| user32 `EnumDisplaySettings` (resolution list) | medium | Electron `screen` module |
| `cmd.exe /c`, `steam.exe`, URL `^&` escaping | medium | `child_process.spawn` + `shell.openExternal`; `External/` `.bat`/`.exe` mods gated behind Wine on Linux |
| Hardcoded `\` separators, `drive.Substring(0,3)` free-space | medium | `path.join`/`path.sep`; `check-disk-space` on the install path |
| Embedded .NET resources (DebugFontTextureDDS, ffxiiiimg.zip, Patch_Revert.zip, ini template) | medium | Ship as files in app resources; read with fs; zips via `fflate` |
| Bundled sub-tool GUIs (WhiteFilelistManager, WDBConversionTools, CLBEditor) | medium | Reimplement needed bits natively or defer the standalone editors |

## Milestones

1. **✅ Crypto core** — block cipher + key schedule, validated byte-for-byte
   against the DLL. *(done)*
2. **Archive read** — `filelist.ts` + `whitebin.ts` unpack; CLI `unpack`. First
   real-data checkpoint: unpack a real `filelistu`/`white_imgu` on a live install
   and diff a few files against the original tool's output. This also validates
   `filelist-crypto.ts` end-to-end.
3. **Archive write** — selective + full repack; round-trip a real archive
   (unpack → repack → byte-identical or game-loads).
4. **Mod manager MVP** — `.ncmp` import + `Data/` overlay install/uninstall with
   backup, on an already-unpacked game. Covers most of the Nexus catalogue.
5. **WPD/TRB + IMGB** — in-container texture mods (the HD packs).
6. **Unpacker + launcher** — bulk unpack + on-disk PE patch + `steam://` launch
   under Proton. Highest-risk; validate on a real Steam Deck.
7. **Electron UI** — 5 tabs (Launch/Settings, Mod Manager, Mod Generator, Tools,
   About); package as AppImage + Flatpak.
8. **ZTR / SCD** — text & audio tooling (optional).

## Nexus Mods integration (built)

The "download → enable/disable, automatic" flow:

1. **Auth** — the user pastes a personal API key (from nexusmods.com → My
   account → API). It's stored encrypted via Electron `safeStorage` in the main
   process and never reaches the renderer. `GET /users/validate.json` returns
   `is_premium`, which picks the download path.
2. **Download** — two paths:
   - **`nxm://` handler (everyone, incl. free accounts)**: open-nova registers
     as the `nxm://` protocol client (`setAsDefaultProtocolClient` + single-
     instance lock + `second-instance`/`open-url` routing). Clicking "Download
     with Manager" on a mod page sends `nxm://{domain}/mods/{id}/files/{fid}?key=&expires=`;
     the app redeems it via `download_link.json` and streams the file.
   - **In-app (Premium)**: `download_link.json` with no grant returns a CDN URL
     directly; a 403 tells free users to use the Mod Manager button instead.
3. **Auto-detect + stage** — the archive is extracted (zip natively; 7z/rar via
   optional WASM deps), `detectMod` infers the layout (Nova `.ncmp` / data-root /
   bare tree / Windows installer), and it's registered in the `ModLibrary`
   (disabled by default).
4. **Enable/disable** — toggling reconciles the game tree through the
   `Deployment` ledger: highest-priority enabled mod wins each file, vanilla
   originals are backed up once and restored when no mod claims them.

**Packaging note (Steam Deck):** `setAsDefaultProtocolClient` alone doesn't
register the scheme on Linux — the packager must ship a `.desktop` with
`MimeType=x-scheme-handler/nxm;` and `Exec=… %U`. Set electron-builder
`build.protocols = { name: 'Nexus Mods Handler', schemes: ['nxm'] }` +
`linux.desktopName` when we add packaging.

## Validation philosophy

Every format module ships with vectors captured from the **original DLL** (via
reflection, as done for crypto) or from round-tripping a real game install. We
trust nothing from the decompilation until a vector confirms it. The decompiled
sources live at `~/nova_decompiled/` for reference only — no original code is
copied into this repo.
