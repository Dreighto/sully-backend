#!/usr/bin/env bash
# gen-app-icons.sh — regenerate EVERY app icon + iOS launch splash from one
# source icon (static/Sully_icon.PNG). Re-run after any icon change:
#     bash scripts/gen-app-icons.sh
#
# Uses ImageMagick. Flattens alpha onto the app background so the marketing
# icon never carries transparency (TestFlight ITMS-90717). Outputs:
#   assets/logo.png            iOS AppIcon source for capacitor-assets (CI).
#   assets/splash.png/-dark    native Capacitor splash source (CI).
#   static/{favicon,apple-touch-icon,icon-512,icon-512-maskable,icon-1024}.png
#   static/ios/splash-*.png    apple-touch-startup-image boot screens.
#
# 2026-06-11 (new Indigo Sully mark): the source is FULL-BLEED opaque art
# (its own near-black indigo field), not trimmed transparent art. So:
#   - BG is the locked --bg0 (#0b0c10), matching the live app surface;
#   - the in-app mark and the splash tile get iOS-style rounded corners
#     (22.5% radius) baked in, so the full-bleed square reads as an app
#     tile instead of a hard-edged box.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="static/Sully_icon.PNG"
BG="#0b0c10" # locked spec --bg0
[ -f "$SRC" ] || {
  echo "ERROR: $SRC not found" >&2
  exit 1
}
mkdir -p assets static/ios

# iOS AppIcon source — full square; capacitor-assets + iOS apply the squircle.
convert "$SRC" -resize 1024x1024 assets/logo.png

# Rounded tile at <px> with transparent corners (iOS-look, radius 22.5%).
rounded() {
  local px="$1" out="$2"
  local r=$((px * 225 / 1000))
  convert "$SRC" -resize "${px}x${px}" \
    \( +clone -alpha extract \
    -draw "fill black polygon 0,0 0,${r} ${r},0 fill white circle ${r},${r} ${r},0" \
    \( +clone -flip \) -compose Multiply -composite \
    \( +clone -flop \) -compose Multiply -composite \
    \) -alpha off -compose CopyOpacity -composite "$out"
}

# Flattened RGB icon at <px>, with the art at <scalePct>% (rest = BG padding).
icon() {
  local px="$1" out="$2" scale="${3:-100}"
  local inner=$((px * scale / 100))
  convert "$SRC" -resize "${inner}x${inner}" -background "$BG" -gravity center \
    -extent "${px}x${px}" -alpha remove -alpha off "$out"
}
icon 192 static/favicon.png
icon 180 static/apple-touch-icon.png
icon 512 static/icon-512.png
icon 512 static/icon-512-maskable.png 80 # maskable safe-zone
icon 1024 static/icon-1024.png

# In-app logo — TRANSPARENT rounded tile for the chat header / sidebar / empty
# state. NOT flattened; the rounded corners keep the full-bleed art from
# reading as a hard square on the app surface.
rounded 512 static/sully-mark.png

# Splash: ROUNDED icon tile centered on BG at ~38% of the shorter edge
# (native-iOS boot-screen look).
ROUNDED_TMP="$(mktemp /tmp/sully-rounded-XXXX.png)"
rounded 1024 "$ROUNDED_TMP"
splash() {
  local w="$1" h="$2" out="$3"
  local min=$((w < h ? w : h))
  local t=$((min * 38 / 100))
  convert "$ROUNDED_TMP" -resize "${t}x${t}" -background "$BG" -gravity center \
    -extent "${w}x${h}" -alpha remove -alpha off "$out"
}
splash 2732 2732 assets/splash.png
cp assets/splash.png assets/splash-dark.png
for wh in 750x1334 828x1792 1080x2340 1125x2436 1170x2532 1179x2556 \
  1206x2622 1242x2208 1242x2688 1284x2778 1290x2796 1320x2868; do
  splash "${wh%x*}" "${wh#*x}" "static/ios/splash-${wh}.png"
done
rm -f "$ROUNDED_TMP"

echo "Generated icons + splashes from $SRC on $BG"
