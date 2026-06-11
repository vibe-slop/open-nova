# open-nova

A cross-platform, open-source mod manager and archive toolkit for the
**FINAL FANTASY XIII trilogy** (XIII, XIII-2, Lightning Returns) on Steam —
built so it actually runs on **Linux and the Steam Deck**, where the original
Windows-only Nova Chrysalia (and the `.bat`/`.exe` mod installers) can't go.

It's a clean reimplementation: the engine is plain TypeScript with **no .NET and
no Windows APIs**, packaged as an Electron app (plus a headless CLI) so it works
on the Deck, Linux desktop, macOS, and Windows alike.

> **Status: working foundation.** The full engine is implemented and tested
> (the proprietary cipher is verified byte-for-byte against the original tool),
> there's a CLI, and an Electron + React + Tailwind app that builds and
> type-checks. What's left is **validation against real game files on a Steam
> Deck** plus in-container texture repack (WPD/IMGB). See
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the roadmap.

## Why this exists

FFXIII-2's game data is locked in encrypted `filelist`/`white_img` archives, so
mods need a tool that can decrypt, unpack, patch and repack them. On Steam Deck
the only existing option is to run Windows tools through Proton or borrow a
Windows PC. open-nova aims to be a native option.

## What works today

- **`@open-nova/core`** — the complete engine, pure TypeScript, no native deps:
  - filelist **cipher** (validated byte-for-byte against the original DLL),
  - **archive** unpack/repack (`filelist` + `white_img`, both game variants,
    encrypted + multi-chunk),
  - **mod manager** (`.ncmp` import, overlay install/uninstall with backup,
    pack generation),
  - **Steam discovery** (cross-platform, no registry) + **PE patching**
    (Large-Address-Aware on disk),
  - **WPD/TRB** container read/write.
  - 116 tests pass: `npm test` (from the repo root).
- **Nexus Mods integration** — connect with a personal API key (stored
  encrypted), then **"Download with Manager"** on any mod page hands the mod to
  open-nova via the `nxm://` handler; it downloads, auto-detects the layout
  (zip/7z/rar/.ncmp), and stages it. You then just flip **enable/disable** — the
  deployment ledger applies/reverts files with priority-based conflict
  resolution and vanilla backups, so nothing is manual and everything is
  reversible. Premium accounts can also install in-app by mod id.
- **`@open-nova/cli`** — `open-nova detect | decrypt | encrypt | unpack | mods`.
- **`@open-nova/app`** — Electron + React + Tailwind UI (5 tabs); builds and
  type-checks.

```bash
npm install            # from repo root (installs all workspaces)
npm test               # run the core test suites
npm run -w @open-nova/app dev    # launch the desktop app (needs a display)
node --import tsx packages/cli/bin/open-nova.mjs detect   # try the CLI
```

### Validated on real hardware ✅
Tested against a real FFXIII-2 install on a Steam Deck: the engine **decrypts
the actual `filelistu.win32.bin`** (checksum verified), parses all **14,381
asset paths**, and unpacks real files from `white_imgu.win32.bin` — they
decompress to byte-exact sizes and carry valid container magic (e.g. `WPD\0`).
This surfaced and fixed a seed sign-extension bug that synthetic tests missed.

### Not yet validated / not yet built
- In-container texture mods (WPD/IMGB repack) and ZTR/SCD tooling.
- The bulk game unpacker (writing the full unpacked tree) and `steam://` launch
  path need a full on-device run.
- Live Nexus download + the `nxm://` handler want an end-to-end run on the Deck.

## How it was built

The original `NovaChrysalia.dll` was decompiled (ILSpy) and each subsystem
reverse-engineered into an implementation-grade spec — see
[`docs/REVERSE-ENGINEERING.md`](docs/REVERSE-ENGINEERING.md). The one piece the
decompiler couldn't recover (a 256-byte cipher S-box) was extracted by reflecting
into the assembly; it turned out to be `Integers[i] = (i + 120) mod 256`.

No original code or proprietary data blobs are copied into this repo — formats
and algorithms are reimplemented from the spec and re-validated against captured
test vectors.

## Layout

```
packages/core    pure-TS engine (crypto ✅, archive/mods/game ▢)
packages/cli     headless commands (planned)
packages/app     Electron UI (planned)
docs/            reverse-engineering reference + architecture
```

## License

GPL-3.0-or-later. This is an interoperability project for game modding; it ships
none of the original tool's code or assets and requires you to own the games.
