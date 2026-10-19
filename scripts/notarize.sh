#!/bin/bash
# Developer ID signing and Apple notarisation, so a downloaded SlideMate opens without Gatekeeper's
# "Open Anyway" step. Used by build-app.sh when SLIDEMATE_SIGN_ID is set; needs an Apple Developer account.
#   scripts/notarize.sh sign <SlideMate.app>       sign everything inside, then the app (hardened runtime)
#   scripts/notarize.sh notarize <app or .dmg>     send to Apple's notary service, wait, staple the ticket
# Environment: SLIDEMATE_SIGN_ID ("Developer ID Application: Name (TEAMID)"), and for notarize APPLE_ID,
# APPLE_TEAM_ID and APPLE_APP_PASSWORD (an app-specific password from appleid.apple.com).
set -euo pipefail
cd "$(dirname "$0")/.."
ID="${SLIDEMATE_SIGN_ID:?set SLIDEMATE_SIGN_ID}"
TARGET="${2:?path}"
case "$1" in
  sign)
    echo "• Signing with $ID…"
    sign() { codesign --force --timestamp --options runtime -s "$ID" "$@"; }
    # Inside out: every Mach-O file in the bundled Python, the AirDrop helper, then the app itself.
    find "$TARGET/Contents/Resources/python" -type f | while read -r f; do
      file -b "$f" | grep -q Mach-O && sign "$f"
    done
    sign "$TARGET/Contents/Resources/Helpers/SlideMateAirDrop.app"
    sign --entitlements macos/SlideMate.entitlements "$TARGET"
    codesign --verify --strict --deep "$TARGET"
    ;;
  notarize)
    echo "• Notarising $(basename "$TARGET") (a few minutes)…"
    SUBMIT="$TARGET"
    if [ -d "$TARGET" ]; then SUBMIT="$(mktemp -d)/$(basename "$TARGET").zip"; ditto -c -k --keepParent "$TARGET" "$SUBMIT"; fi
    xcrun notarytool submit "$SUBMIT" --wait --apple-id "${APPLE_ID:?}" --team-id "${APPLE_TEAM_ID:?}" \
      --password "${APPLE_APP_PASSWORD:?}"
    xcrun stapler staple "$TARGET"
    ;;
  *) echo "usage: $0 sign|notarize <path>"; exit 1 ;;
esac
