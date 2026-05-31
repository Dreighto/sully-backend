#!/usr/bin/env bash
# ci-ios-icons.sh — generate the iOS AppIcon set from assets/logo.png and
# defensively flatten the 1024 marketing icon's alpha.
#
# ios/ is regenerated fresh every CI build (`npx cap add ios`), so the AppIcon
# set must be (re)generated AFTER `cap add ios` + `cap sync ios` on every build,
# sourcing from the committed assets/logo.png. TestFlight rejects ANY alpha in
# the 1024 marketing icon (ITMS-90717) and @capacitor/assets does not reliably
# strip it, so we flatten AppIcon-512@2x.png onto an opaque background.
#
# Run from the repo root, AFTER `npx cap sync ios`.
set -euo pipefail

# Easy Mode: single assets/logo.png + opaque background colors so the marketing
# icon is born without transparency. (#050505 = LogueOS Console background.)
npx capacitor-assets generate --ios \
  --iconBackgroundColor '#050505' \
  --iconBackgroundColorDark '#050505'

ICON="ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
if [ ! -f "$ICON" ]; then
  echo "ERROR: $ICON not found after 'capacitor-assets generate'" >&2
  exit 1
fi

# Defensive alpha flatten (ITMS-90717). Prefer ImageMagick; fall back to sips
# (always present on macOS runners) via a JPEG round-trip that drops alpha.
if command -v magick >/dev/null 2>&1; then
  magick "$ICON" -background '#050505' -alpha remove -alpha off "$ICON"
elif command -v convert >/dev/null 2>&1; then
  convert "$ICON" -background '#050505' -alpha remove -alpha off "$ICON"
else
  sips -s format jpeg "$ICON" --out /tmp/_icon_flat.jpg >/dev/null
  sips -s format png /tmp/_icon_flat.jpg --out "$ICON" >/dev/null
fi

echo "Marketing icon (must report RGB, no alpha):"
file "$ICON"
