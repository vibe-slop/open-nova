# CLAUDE.md

Domain knowledge for the FINAL FANTASY XIII trilogy archive + modding formats.

- **WhiteBin archives**: game data is `filelist*` (encrypted path index, XOR
  block cipher + zlib) paired with `white_img*` (the bodies). Per-game data
  roots: `white_data` (XIII), `alba_data` (XIII-2), `weiss_data` (LR). Each
  game's executable lives at `<dataRoot>/prog/win/bin/` (where loose overlay
  files like `d3d9.dll` are placed).
- **fileCode** is a deterministic **bit-pack of the path** (not a hash) — used to
  register added files (e.g. restored DLC) into the live filelist generically
  (`packages/core/src/archive/filecode.ts`).
- **Zone-archive pairing**: `findArchivePairs` matches `filelist_z<id><u/c>` ↔
  `white_z<id><u/c>_img`, including the `.bin2` / `_img2` split parts. All 184
  archives must pair (not just 8) or gameplay null-derefs — don't regress this.
- **Mod deployment** is a ledger/reconcile model (`mods/library.ts` →
  `mods/deployment.ts`): enabled mods provide files; `reconcile` applies them
  with priority-based conflict resolution and reversible vanilla backups, then
  `reconcileFilelist` registers any *added* paths.
