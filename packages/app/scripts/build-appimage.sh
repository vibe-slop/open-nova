set -e
export PATH="$HOME/node/bin:$PATH"
ROOT="$HOME/open-nova"; ED="$ROOT/node_modules/electron/dist"
AD="$HOME/onpkg/open-nova.AppDir"
rm -rf "$HOME/onpkg"; mkdir -p "$AD"
echo "copying electron dist..."; cp -a "$ED/." "$AD/"
mkdir -p "$AD/resources/app"
cp -a "$ROOT/packages/app/out" "$AD/resources/app/out"
cp -a "$ROOT/packages/app/resources" "$AD/resources/app/resources"
printf '{"name":"open-nova","version":"0.1.0","type":"module","main":"out/main/index.js"}\n' > "$AD/resources/app/package.json"
printf '#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/electron" "$@"\n' > "$AD/AppRun"; chmod +x "$AD/AppRun"
cat > "$AD/open-nova.desktop" <<DESK
[Desktop Entry]
Name=open-nova
Exec=AppRun %U
Icon=open-nova
Type=Application
Categories=Game;
MimeType=x-scheme-handler/nxm;
DESK
node "$HOME/make-icon.mjs" "$AD/open-nova.png"; cp "$AD/open-nova.png" "$AD/.DirIcon"
echo "fetching appimagetool..."
curl -fsSL https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage -o "$HOME/appimagetool"; chmod +x "$HOME/appimagetool"
cd "$HOME/onpkg"
echo "building AppImage..."
ARCH=x86_64 "$HOME/appimagetool" --appimage-extract-and-run open-nova.AppDir open-nova-x86_64.AppImage 2>&1 | tail -12
ls -lh "$HOME/onpkg/"*.AppImage
