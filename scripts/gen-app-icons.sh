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
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="static/Sully_icon.PNG"
BG="#050505" # Sully app background (matches ci-ios-icons.sh)
[ -f "$SRC" ] || {
  echo "ERROR: $SRC not found" >&2
  exit 1
}
mkdir -p assets static/ios

# iOS AppIcon source — keep alpha; capacitor-assets + ci-ios-icons.sh flatten it.
convert "$SRC" -resize 1024x1024 assets/logo.png

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

# In-app logo — TRANSPARENT trimmed mark for the chat header / sidebar / empty
# state. NOT flattened, so the magenta glow hugs the mark itself (a flattened
# square reads as an unpolished dark box on the app background).
convert "$SRC" -trim +repage -resize 452x452 -background none -gravity center \
  -extent 512x512 static/sully-mark.png

# Splash: icon centered on BG at ~38% of the shorter edge.
splash() {
  local w="$1" h="$2" out="$3"
  local min=$((w < h ? w : h))
  local t=$((min * 38 / 100))
  convert "$SRC" -resize "${t}x${t}" -background "$BG" -gravity center \
    -extent "${w}x${h}" -alpha remove -alpha off "$out"
}
splash 2732 2732 assets/splash.png
cp assets/splash.png assets/splash-dark.png
for wh in 750x1334 828x1792 1080x2340 1125x2436 1170x2532 1179x2556 \
  1206x2622 1242x2208 1242x2688 1284x2778 1290x2796 1320x2868; do
  splash "${wh%x*}" "${wh#*x}" "static/ios/splash-${wh}.png"
done

echo "Generated icons + splashes from $SRC on $BG"
