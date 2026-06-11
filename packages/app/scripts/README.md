# Building the Linux AppImage (Steam Deck)

The AppImage must be built on a Linux x86_64 host (the Steam Deck itself works).

## Why not `electron-builder`?

`electron-builder`'s "install production dependencies" step runs
`npm install --production` in the app dir, which — in an npm **workspace** —
prunes devDependencies from the hoisted root `node_modules` (including its own
`7zip-bin`), then fails to `chmod` the binary it just deleted. Rather than fight
that, `build-appimage.sh` assembles the AppImage manually with `appimagetool`
(exactly what electron-builder does internally, minus the dependency pruning).

## Build

On the Deck (with Node on PATH and the app already built via `electron-vite build`):

```bash
npm install -w @open-nova/app          # ensure node_modules/electron/dist exists
npm run -w @open-nova/app build         # electron-vite build -> packages/app/out
bash packages/app/scripts/build-appimage.sh
# -> ~/onpkg/open-nova-x86_64.AppImage
```

The script:
1. copies `node_modules/electron/dist` into an AppDir,
2. drops the bundled app (`out/` + `resources/`) into `resources/app/`,
3. writes `AppRun`, the `.desktop` entry (with `MimeType=x-scheme-handler/nxm;`
   so the Nexus "Download with Manager" button works), and an icon
   (`make-icon.mjs`),
4. runs `appimagetool` to produce the AppImage.

`electron-builder` config still lives in `packages/app/package.json` for when a
non-workspace / CI build environment makes it viable.
