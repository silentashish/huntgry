#!/bin/sh
# Regenerates the app icons from resources/icon.svg:
#   resources/icon.png   1024px: dev dock icon, window icon, electron-builder (Linux/Windows)
#   resources/icon.icns  macOS bundle icon (needs macOS: sips + iconutil)
set -e
cd "$(dirname "$0")/.."
npx electron scripts/render-icon.cjs
if command -v iconutil >/dev/null 2>&1; then
  set_dir=$(mktemp -d)/icon.iconset
  mkdir -p "$set_dir"
  for size in 16 32 128 256 512; do
    sips -z $size $size resources/icon.png --out "$set_dir/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z $double $double resources/icon.png --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$set_dir" -o resources/icon.icns
fi
