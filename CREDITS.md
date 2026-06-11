# Credits

open-nova reimplements the FINAL FANTASY XIII trilogy archive/mod formats from
scratch (see `docs/REVERSE-ENGINEERING.md`). It ships none of the original Nova
Chrysalia tool's code, and no Square Enix game assets.

## Bundled community fixes

- **Rain Translucency Fix** — the two rain textures in
  `packages/core/assets/fixes/rain-leviathans-tears/` are from **Leviathan's
  Tears v1.3 by Krisan Thyme**, included in open-nova **with the author's
  explicit permission**. Per the author, these are *new* textures (not Square
  Enix assets). Thanks to Krisan Thyme for allowing redistribution.

## Format research

- The FF13 modding community — the LR Research Team's Fabula Nova Crystallis
  Modding Wiki, and **Surihix** (WhiteBinTools / WPDtool / IMGBlibrary, which are
  open source) — whose documentation and open tools made the format work
  possible.
- Krisan Thyme, author of the original (closed-source) Nova Chrysalia, whose
  decompiled binary was the reference for the clean-room reimplementation.

You must own the games. open-nova is GPL-3.0-or-later.

- **FF13Fix + DXVK filtering** — the files in
  `packages/core/assets/fixes/ff13fix/` are **FF13Fix by rebtd7** (a fork of
  **OneTweakNG by Nucleoprotein**), licensed **GPL-3.0** (see
  `assets/fixes/ff13fix/LICENSES/`), bundled here under the GPL with thanks. The
  `dxvk.conf` forces 16x anisotropic texture filtering on the Steam Deck. d3d9.dll
  also contains MinHook (BSD) — see `MinHook_LICENSE.txt`. This fix is enabled by
  default; disable it in the Mod Manager if you don't want it.
