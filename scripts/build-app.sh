#!/bin/bash
# Build SlideMate.app (native window + bundled server + AirDrop helper).
#   scripts/build-app.sh            → build/SlideMate.app
#   scripts/build-app.sh --install  → also copy it to /Applications (or ~/Applications)
#   scripts/build-app.sh --zip      → also make dist/SlideMate-<version>-macOS.zip (what GitHub Releases ship)
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

echo "• Signing (ad-hoc)…"
codesign -s - --force "$APP" >/dev/null 2>&1   # not --deep: the helper keeps its own (stable) signature
echo "✓ Built $APP"

if [ "${1:-}" = "--zip" ]; then
  mkdir -p "$ROOT/dist"
  ZIP="$ROOT/dist/SlideMate-$VERSION-macOS.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  echo "✓ $ZIP ($(du -h "$ZIP" | cut -f1))"
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
