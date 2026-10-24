#!/bin/bash
# Build SlideMate.app (native window + bundled server + AirDrop helper).
#   scripts/build-app.sh            → build/SlideMate.app
#   scripts/build-app.sh --install  → also copy it to /Applications (or ~/Applications)
#   scripts/build-app.sh --zip      → also make dist/SlideMate-<version>-macOS.zip (the in-app updater's download)
#                                     and dist/SlideMate-<version>-macOS.dmg (drag-to-Applications, for new users)
# With SLIDEMATE_SIGN_ID set (a "Developer ID Application" identity), it signs for Gatekeeper and, with the notary
# credentials too, notarises (scripts/notarize.sh): then the download opens with no "Open Anyway" step.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
BUILD="$ROOT/build"
APP="$BUILD/SlideMate.app"
HELPER="$BUILD/SlideMateAirDrop.app"
VERSION=$(cat VERSION 2>/dev/null || echo "0.1.0")

command -v swiftc >/dev/null || { echo "swiftc not found. Install the Xcode Command Line Tools: xcode-select --install"; exit 1; }
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Helpers"

# Universal binaries: one app runs on both Apple Silicon and Intel Macs.
universal() {  # universal <source.swift> <output>
  local tmp; tmp=$(mktemp -d)
  swiftc -O -target arm64-apple-macos13 "$1" -o "$tmp/arm64"
  if swiftc -O -target x86_64-apple-macos13 "$1" -o "$tmp/x86_64" 2>/dev/null; then
    lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$2"
  else
    cp "$tmp/arm64" "$2"  # SDK without Intel support: Apple Silicon only
  fi
  rm -rf "$tmp"
}
echo "• Compiling SlideMate…"
universal macos/SlideMate/main.swift "$APP/Contents/MacOS/SlideMate"
# The AirDrop helper needs macOS Accessibility permission, which is tied to its exact code signature.
# Rebuilding it would silently revoke that permission, so build it once per source version and reuse the
# identical signed copy on every later build.
HELPER_KEY=$( (cat macos/AirDrop/airdrop.swift; echo "helper-plist-v1") | shasum -a 256 | cut -c1-16)
HELPER_CACHE="${SLIDEMATE_HELPER_CACHE:-$HOME/Library/Caches/SlideMate}/helper-$HELPER_KEY/SlideMateAirDrop.app"
if [ -d "$HELPER_CACHE" ] && codesign --verify "$HELPER_CACHE" 2>/dev/null; then
  echo "• AirDrop helper unchanged (keeps its Accessibility permission)"
else
  echo "• Compiling AirDrop helper…"
  rm -rf "$HELPER_CACHE"; mkdir -p "$HELPER_CACHE/Contents/MacOS"
  universal macos/AirDrop/airdrop.swift "$HELPER_CACHE/Contents/MacOS/SlideMateAirDrop"
  cat > "$HELPER_CACHE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.slidemate.airdrop</string>
<key>CFBundleName</key><string>SlideMate AirDrop</string>
<key>CFBundleExecutable</key><string>SlideMateAirDrop</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
  codesign -s - --force -i app.slidemate.airdrop "$HELPER_CACHE" >/dev/null 2>&1
fi
rm -rf "$HELPER"; ditto "$HELPER_CACHE" "$HELPER"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.slidemate</string>
<key>CFBundleName</key><string>SlideMate</string>
<key>CFBundleDisplayName</key><string>SlideMate</string>
<key>CFBundleExecutable</key><string>SlideMate</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>SlideMate records lectures (only when you press Record) so it can transcribe them on your Mac.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>CFBundleDocumentTypes</key><array><dict>
  <key>CFBundleTypeName</key><string>PDF</string>
  <key>CFBundleTypeRole</key><string>Viewer</string>
  <key>LSHandlerRank</key><string>Alternate</string>
  <key>LSItemContentTypes</key><array><string>com.adobe.pdf</string></array>
</dict></array>
</dict></plist>
PLIST

echo "• Bundling server…"
rsync -a --exclude '__pycache__' --exclude '*.pyc' server "$APP/Contents/Resources/"

# A standalone Python (python-build-standalone) goes in the app, so it never needs Apple's Command Line Tools,
# whose installer can ask for 15+ GB of free space. Both architectures are merged into one universal tree, and
# what the server never uses (Tk, IDLE, pip, tests, headers) is left out.
PY_VERSION=3.13.16 PY_BUILD=20261013
PY_SHA_aarch64=16a5332fb0dcb77f163fc8f8cbccd95be1644cc53e68e5d2a79f50afd6680a0e
PY_SHA_x86_64=f507ae04eb7747cd97cb484e8c5d83936cbfc52d9b08a1f35c00b47c707b1ae1
PY_CACHE="${SLIDEMATE_PYTHON_CACHE:-$HOME/Library/Caches/SlideMate}/python-$PY_VERSION-$PY_BUILD-universal"
if [ ! -x "$PY_CACHE/bin/python3" ]; then
  echo "• Downloading Python ${PY_VERSION}…"
  TMP=$(mktemp -d)
  for arch in aarch64 x86_64; do
    tgz="$TMP/$arch.tar.gz"
    curl -fsSL -o "$tgz" "https://github.com/astral-sh/python-build-standalone/releases/download/$PY_BUILD/cpython-$PY_VERSION+$PY_BUILD-$arch-apple-darwin-install_only_stripped.tar.gz"
    want="PY_SHA_$arch"
    [ "$(shasum -a 256 "$tgz" | cut -d' ' -f1)" = "${!want}" ] || { echo "Python download for $arch failed its checksum"; exit 1; }
    mkdir -p "$TMP/$arch" && tar -xzf "$tgz" -C "$TMP/$arch"
    P="$TMP/$arch/python"
    rm -rf "$P/include" "$P/share" "$P/lib/pkgconfig" "$P/lib/libpython3.13.dylib" "$P"/lib/libtcl* "$P"/lib/itcl* \
      "$P"/lib/tcl* "$P"/lib/tk* "$P"/lib/thread* "$P"/lib/python3.13/lib-dynload/_tkinter*
    (cd "$P/lib/python3.13" && rm -rf test idlelib tkinter turtledemo turtle.py ensurepip pydoc_data lib2to3 \
      config-3.13-darwin site-packages/* venv)
    (cd "$P/bin" && ls | grep -vx -e python3 -e python3.13 | xargs rm -f)
  done
  # The binary is statically linked, so the stdlib's few compiled modules are the only other code to merge.
  A="$TMP/aarch64/python" X="$TMP/x86_64/python"
  (cd "$A" && find . -type f) | while read -r f; do
    if file -b "$A/$f" | grep -q Mach-O; then
      lipo -create "$A/$f" "$X/$f" -output "$A/$f.uni" && mv "$A/$f.uni" "$A/$f"
      codesign -s - --force "$A/$f" >/dev/null 2>&1
    fi
  done
  rm -rf "$PY_CACHE" && mkdir -p "$(dirname "$PY_CACHE")" && mv "$A" "$PY_CACHE"
  rm -rf "$TMP"
fi
ditto "$PY_CACHE" "$APP/Contents/Resources/python"
ditto "$HELPER_CACHE" "$APP/Contents/Resources/Helpers/SlideMateAirDrop.app"

echo "• Icon…"
TMP=$(mktemp -d)
qlmanage -t -s 1024 -o "$TMP" macos/icon.svg >/dev/null 2>&1 || true
if [ -f "$TMP/icon.svg.png" ]; then
  mkdir -p "$TMP/AppIcon.iconset"
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$TMP/icon.svg.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$TMP/icon.svg.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
fi
rm -rf "$TMP"

if [ -n "${SLIDEMATE_SIGN_ID:-}" ]; then
  scripts/notarize.sh sign "$APP"
else
  echo "• Signing (ad-hoc)…"
  codesign -s - --force "$APP" >/dev/null 2>&1   # not --deep: the helper keeps its own (stable) signature
fi
echo "✓ Built $APP"

if [ "${1:-}" = "--zip" ]; then
  mkdir -p "$ROOT/dist"
  ZIP="$ROOT/dist/SlideMate-$VERSION-macOS.zip"
  rm -f "$ZIP"
  [ -n "${SLIDEMATE_SIGN_ID:-}" ] && [ -n "${APPLE_ID:-}" ] && scripts/notarize.sh notarize "$APP"
  # Keep the guide outside the app so it can be read before macOS allows the first launch.
  # SlideMate.app stays at the ZIP root, where the in-app updater expects to find it.
  STAGE=$(mktemp -d)
  ditto "$APP" "$STAGE/SlideMate.app"
  cp "$ROOT/docs/first-launch.html" "$STAGE/Start Here.html"
  ditto -c -k "$STAGE" "$ZIP"
  echo "✓ $ZIP ($(du -h "$ZIP" | cut -f1))"
  # Add the Applications shortcut only to the disk image, alongside the same app and guide.
  DMG="$ROOT/dist/SlideMate-$VERSION-macOS.dmg"
  ln -s /Applications "$STAGE/Applications"
  rm -f "$DMG"
  hdiutil create -quiet -volname "SlideMate" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
  rm -rf "$STAGE"
  [ -n "${SLIDEMATE_SIGN_ID:-}" ] && codesign -s "$SLIDEMATE_SIGN_ID" --timestamp "$DMG"
  [ -n "${SLIDEMATE_SIGN_ID:-}" ] && [ -n "${APPLE_ID:-}" ] && scripts/notarize.sh notarize "$DMG"
  echo "✓ $DMG ($(du -h "$DMG" | cut -f1))"
fi

if [ "${1:-}" = "--install" ]; then
  DEST=/Applications
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  rm -rf "$DEST/SlideMate.app"
  cp -R "$APP" "$DEST/"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST/SlideMate.app" || true
  echo "✓ Installed to $DEST/SlideMate.app"
fi
