# Nova Chrysalia — Reverse-Engineering Reference

This documents the on-disk formats and algorithms used by the FINAL FANTASY
XIII / XIII-2 / Lightning Returns Steam PC ports, as implemented by Nova
Chrysalia v2.0.3. It was produced by decompiling `NovaChrysalia.dll` (net6.0,
WPF) with ILSpy and reading the source. The goal is a clean-room-quality spec so
the engine can be reimplemented in TypeScript with **no .NET / Windows
dependency**.

> Legal note: formats and algorithms are not copyrightable; this is an
> interoperability reimplementation. Do not copy the original's compiled code or
> bundled proprietary blobs. Re-derive everything (as done here for the cipher).

---

## 1. The "WhiteBin" container (filelist + white_img)

Almost all game data lives in **paired files** under the game's data root
(`white_data` for XIII, `alba_data` for XIII-2, `weiss_data` for LR):

- **`filelist*.win32.bin`** — the index (table of contents).
- **`white_img*.win32.bin`** — the payload (file bodies).

Suffix conventions: `u`/`c` = EN/JP voice sets (XIII, XIII-2); `a`/`v`/`""` for
LR. The main pair XIII-2 mods touch is `filelistu`/`white_imgu` in `alba_data/sys`.

### 1.1 Filelist (index) layout

All integers little-endian unless noted. For an **encrypted** filelist
(XIII-2 / LR), all offsets below are relative to a 32-byte base header — i.e.
add `0x20`. FFXIII-1 filelists are plaintext (base 0).

```
Header (12 bytes):
  +0  uint32  chunkInfoSectionOffset   (relative; +0x20 if encrypted)
  +4  uint32  chunkDataSectionOffset   (relative; +0x20 if encrypted)
  +8  uint32  totalFiles
Entries: totalFiles × 8-byte records, starting at +12
ChunkInfo @ chunkInfoSectionOffset: totalChunks = size/12; each record 12 bytes:
  +0 uint32 uncompressedSize  +4 uint32 chunkCmpSize  +8 uint32 chunkStartOffset
ChunkData @ chunkDataSectionOffset: each chunk = a zlib stream (0x78 0xDA) of
  length chunkCmpSize at chunkDataSectionOffset+chunkStartOffset.
```

Each chunk decompresses to a blob of NUL-terminated UTF-8 strings of the form
`pos:uncmpSize:cmpSize:path` (the numbers in **hex**), terminated by `end\0`.

- `pos × 2048 (0x800)` = absolute byte offset of the file body in `white_img`.
- `uncmpSize == cmpSize` ⇒ stored raw; otherwise zlib-compressed.
- `path` uses `/`; the sentinel `" "` (single space) means "no path" → file
  named `FILE_<n>` under `noPath/`.

### 1.2 Per-file entry (8 bytes) — differs by game

**FFXIII-1 (gameCode 1):**
```
+0 uint32 FileCode   +4 uint16 ChunkNumber   +6 uint16 PathStringPos
```

**FFXIII-2 / LR (gameCode 2/3):**
```
+0 uint32 FileCode   +4 uint16 PathStringPos (high bit 0x8000 = flag)
+6 uint8 ChunkSubIndex   +7 uint8 FileTypeID
```
For 2/3 the *real* chunk index is tracked by a running counter starting at `-1`:
`PathStringPos == 0` → counter++; `== 0x8000` → counter++ and subtract 32768;
`> 32768` → subtract 32768 only. Odd-indexed chunks carry the `0x8000` flag.

### 1.3 Payload (white_img) extraction / repack

- **Unpack**: seek `pos×2048`; if compressed, read `cmpSize` bytes and zlib-
  inflate; else copy `uncmpSize` bytes. Extract dir = `_<binName>/`.
- **Repack (full)**: rebuild from the `_<binName>/` tree, each body padded to a
  2048 boundary; recompress if it was compressed; rewrite the filelist; re-encrypt
  if the original was encrypted.
- **Repack (selective)**: if the new body fits the old slot → inject in place;
  else append to end and null-wipe the old slot. `white_img` is backed up `.bak`.
- zlib here is **RFC1950** (2-byte header + Adler32), level = SmallestSize (max),
  **not** raw deflate. Node: `zlib.deflateSync(buf, {level: 9})` /
  `zlib.inflateSync`.

---

## 2. The filelist cipher (XIII-2 / LR only)  ✅ ported + validated

A custom 8-byte block cipher protects the XIII-2/LR filelist index. It is the
same engine the old `ff13crypt` used. **This is fully reimplemented and verified
byte-for-byte against the original DLL** — see
`packages/core/src/crypto/cipher.ts` and `test/crypto.vectors.test.mjs`.

- **Detection**: uint32 LE at offset `0x14` == `501232760` (`0x1DE5BCB8`).
- **Body size**: uint32 **big-endian** at offset `0x10`, then `+8`.
- **Header**: first `0x20` bytes copied verbatim; body starts at `0x20`.
- **Seed**: from the 16-byte header, `value = (h[9]<<24)|(h[12]<<16)|(h[2]<<8)|h[0]`;
  the 8-byte little-endian form of `value` is the cipher seed.
- **Key schedule** (`generateXorTable`): 264-byte table (33×8). Block 0 from the
  rotated/transformed seed; blocks 1..32 are `next = (5 × prev) mod 2^64`.
- **Per block** (8 bytes): table offset = `blockCounter & 0xF8`; two 32-bit
  subkeys from the table; two 64-bit "special keys" (`+2707759943`, carry at
  `>1587207352`). Byte-chaining + S-box, then 64-bit add/sub-with-carry + XOR.
- **S-box** (`IntegersArray.Integers`): the decompiler could **not** recover this
  256-byte table (it's a `RuntimeHelpers.InitializeArray` RVA blob). It was
  extracted by reflecting into the DLL and turns out to be trivial:
  **`Integers[i] = (i + 120) mod 256`** (a bijection). This was the one thing
  that could have blocked the whole port.
- **Checksum**: sum of every 4th byte over the body (mod 2^32); stored/verified
  at the tail.

The same engine also handles `.clb` script files (magic `0x54534C43` "CLST",
8-byte seed = first 8 bytes) and save files (per-game hardcoded seeds; XIII-2
save crypt is disabled in the original). Those seeds are unrecovered blobs but
are not needed for mod management.

---

## 3. Mod manager + `.ncmp` format

A **ModPack** is a `.ncmp` file = a plain **ZIP** containing:

```
modconfig.ini          manifest (see below)
Data/                  files mirroring the game's unpacked tree (always applied)
EN-Data/  JP-Data/     voice-set-specific overlays (optional)
External/              a Windows Install/Setup .bat or .exe (legacy escape hatch)
Code/<name>.nccp       a runtime code patch (consumed at launch)
image/preview/banner/readme   optional presentation assets
```

`modconfig.ini` has two sections — note the **misspelling** `NovaChysaliaConfig`,
which must be preserved for interop:

```ini
[ModPackConfig]
Name= ...   Version= ...   Author= ...   GameEntry= 1|2|3
Summary= ...  Image= ...  Preview= ...  Banner= ...  Readme= ...
[NovaChysaliaConfig]
DataPatch=true   ENPatch=...  JPPatch=...  ExtPatch=...  CodePatch=...
Installed=false  ENInstalled=false  JPInstalled=false
```

**Install model** (this is the important part, and it's almost entirely portable
fs work):

1. Walk the `Data/` (and EN/JP) tree. Each file maps 1:1 onto a path under the
   game's unpacked data root.
2. **Before overwriting**, copy the original to `Backup/<GameId>/<rel>` — but only
   if no backup exists yet and the original is present.
3. Copy the mod file over the game file.
4. If a target lives **inside** a packed container (`.bin/.xwp/.wdb/.wpd/.wpk/
   .xfv/.xgr/.xwb` — detected via `_`-prefixed folder names), unpack that
   container (WPD), drop files in, and repack it (`!!WPD_Records.txt` drives
   the file ordering).
5. `Code/*.nccp` is copied into `Patches/<GameId>/`.

**Uninstall** = for each touched file, restore from `Backup/` if present, else
delete. State is tracked by the INI flags + the backup folder. **There is no
database for mod tracking** (the bundled SQLite/EntityFramework is for the WDB
game-database editor tool, not the mod manager).

`External/` runs a Windows `.bat`/`.exe` — this is the only inherently
non-portable install path and should be gated behind Wine/Proton (or skipped).

---

## 4. Game discovery, unpack & launch

- **Steam discovery** (original uses the Windows registry): replace with
  cross-platform probing — Linux `~/.steam/steam`, `~/.local/share/Steam`,
  `~/.var/app/com.valvesoftware.Steam/.local/share/Steam` (Flatpak); macOS
  `~/Library/Application Support/Steam`. Parse `steamapps/libraryfolders.vdf`
  for libraries; the app IDs are **292120 / 292140 / 345350**.
- **"Unpacked Mode"**: the unpacker bulk-extracts every WhiteBin pair into the
  loose-file tree (~60 GB for XIII-2), and the game is told to read loose files.
- **Launch + patching** (the hard part): the original starts the game suspended
  and writes byte patches into **process memory** (`WriteProcessMemory`) at fixed
  module-relative offsets to enable unpacked mode, set text language, and debug.
  This does **not** port to Linux/Proton. The portable substitute is to patch the
  **on-disk exe** before launch (the same byte edits, mapping RVA→file offset via
  the PE section table) and restore from a `.original` backup, then launch via
  `steam://rungameid/<appid>` (which the original already does for LR). The
  Large-Address-Aware bit patch (e_lfanew @ 0x3C, characteristics @ pe+22, flag
  0x20) is trivial fs+Buffer work.

See `ARCHITECTURE.md` for the full Windows-dependency inventory and port plan.

---

## 5. Inner asset formats (inside the archives)

Ranked for a mod-install MVP:

- **WPD** (`WPD\0`, big-endian count @4, 32-byte records @16) and **TRB**
  (`SEDBRES `) — resource bundles holding texture header blocks. **Essential**
  (needed for any in-container texture mod).
- **IMGB / GTEX + DDS** — textures (what most mods change). Unpack mips → DDS,
  repack DDS → imgb patching GTEX offset tables. **Essential.**
- **ZTR** — dictionary-encoded text; needs codepage support (932/950/51949 via
  `iconv-lite`). **High** value, deferrable.
- **SCD / WMP** — sound (relates to the bundled `oggenc2`/`VorbisEncoder`/ffmpeg).
  **Defer** for v1.
- **INI** — original wraps Win32 `GetPrivateProfileString`; replace with a JS INI
  lib, preserving the leading-space-on-write quirk.

Many popular mods ship as **loose files already in the right tree** (or as a
`.ncmp`), so a v1 that supports unpacked-tree overlay + WPD repack covers most of
the catalogue without IMGB/ZTR yet.
