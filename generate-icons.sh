#!/bin/bash

# Icon Generator für ESP32Tool PWA
# Erstellt einfache Placeholder-Icons falls ImageMagick installiert ist

echo "🎨 ESP32Tool Icon Generator"
echo ""

# Prüfe ob ImageMagick installiert ist
if ! command -v convert &> /dev/null; then
    echo "❌ ImageMagick ist nicht installiert!"
    echo ""
    echo "Installation:"
    echo "  macOS:  brew install imagemagick"
    echo "  Linux:  sudo apt install imagemagick"
    echo "  Windows: https://imagemagick.org/script/download.php"
    echo ""
    echo "Alternativ: Nutze ein Online-Tool wie https://realfavicongenerator.net/"
    exit 1
fi

# Erstelle icons Ordner
mkdir -p icons
mkdir -p screenshots

echo "📦 Erstelle Icon-Größen..."

# Farben
BG_COLOR="#1a1a1a"
TEXT_COLOR="#ffffff"
ACCENT_COLOR="#4CAF50"

# Erstelle Icons mit ESP32 Text
for size in 72 96 128 144 152 192 384 512; do
    # Berechne Schriftgröße basierend auf Icon-Größe
    fontsize=$((size / 6))
    
    convert -size ${size}x${size} xc:${BG_COLOR} \
        -fill ${ACCENT_COLOR} -draw "circle $((size/2)),$((size/2)) $((size/2)),$((size/4))" \
        -fill ${TEXT_COLOR} -pointsize ${fontsize} -font "DejaVu-Sans-Bold" \
        -gravity center -annotate +0-$((size/12)) "ESP32" \
        -pointsize $((fontsize/2)) -annotate +0+$((size/8)) "TOOL" \
        icons/icon-${size}.png
    
    echo "  ✅ icon-${size}.png"
done

# Erstelle Favicon
convert icons/icon-192.png -resize 32x32 favicon.ico
echo "  ✅ favicon.ico"

# Erstelle Apple Touch Icon
convert icons/icon-192.png -resize 180x180 apple-touch-icon.png
echo "  ✅ apple-touch-icon.png"

# Erstelle Placeholder Screenshots
echo ""
echo "📸 Erstelle Placeholder Screenshots..."

# Desktop Screenshot (1280x720)
convert -size 1280x720 xc:${BG_COLOR} \
    -fill ${TEXT_COLOR} -pointsize 48 -font "Helvetica-Bold" \
    -gravity center -annotate +0-100 "ESP32Tool" \
    -pointsize 24 -annotate +0+0 "Flash & Read ESP Devices" \
    -pointsize 18 -annotate +0+50 "Desktop View" \
    screenshots/desktop.png
echo "  ✅ desktop.png (1280x720)"

# Mobile Screenshot (540x720)
convert -size 540x720 xc:${BG_COLOR} \
    -fill ${TEXT_COLOR} -pointsize 36 -font "Helvetica-Bold" \
    -gravity center -annotate +0-100 "ESP32Tool" \
    -pointsize 18 -annotate +0+0 "Flash & Read" \
    -pointsize 18 -annotate +0+30 "ESP Devices" \
    -pointsize 14 -annotate +0+80 "Mobile View" \
    screenshots/mobile.png
echo "  ✅ mobile.png (540x720)"

echo ""
echo "✨ Fertig! Icons und Screenshots wurden erstellt."
echo ""
echo "📁 Dateien:"
echo "  - icons/icon-*.png (8 Größen)"
echo "  - favicon.ico"
echo "  - apple-touch-icon.png"
echo "  - screenshots/*.png"
echo ""
echo "💡 Tipp: Ersetze die Placeholder-Icons mit deinem eigenen Logo!"
echo "   Nutze dazu: convert dein-logo.png -resize 512x512 icons/icon-512.png"
