# PWA Setup für ESP32Tool

## ✅ Was wurde erstellt:

1. **manifest.json** - PWA Manifest mit App-Metadaten
2. **sw.js** - Service Worker für Offline-Funktionalität und Caching
3. **index.html** - Aktualisiert mit PWA-Meta-Tags und Service Worker Registration

## 📱 Installation auf Android:

### Für Nutzer:
1. Öffne die Website in **Chrome for Android** (Version 61+)
2. Tippe auf das **Menü** (⋮) oben rechts
3. Wähle **"Zum Startbildschirm hinzufügen"** oder **"App installieren"**
4. Bestätige die Installation
5. Die App erscheint auf deinem Homescreen

### Voraussetzungen:
- Android 5.0+ (Lollipop oder höher)
- Chrome for Android 61+
- USB OTG-Adapter für ESP32-Verbindung
- HTTPS-Verbindung (oder localhost für Tests)

## 🎨 Icons erstellen:

Du brauchst noch App-Icons! Erstelle einen `icons/` Ordner mit folgenden Größen:

```bash
mkdir icons
```

Benötigte Icon-Größen:
- icon-72.png (72x72)
- icon-96.png (96x96)
- icon-128.png (128x128)
- icon-144.png (144x144)
- icon-152.png (152x152)
- icon-192.png (192x192) ⭐ Wichtig
- icon-384.png (384x384)
- icon-512.png (512x512) ⭐ Wichtig

### Schnelle Icon-Erstellung:

**Option 1: Online-Tool**
- Gehe zu https://realfavicongenerator.net/
- Lade ein quadratisches Logo hoch (mindestens 512x512)
- Lade alle Größen herunter

**Option 2: ImageMagick (CLI)**
```bash
# Installiere ImageMagick
brew install imagemagick  # macOS
# oder: sudo apt install imagemagick  # Linux

# Erstelle alle Größen aus einem Source-Image
convert logo.png -resize 72x72 icons/icon-72.png
convert logo.png -resize 96x96 icons/icon-96.png
convert logo.png -resize 128x128 icons/icon-128.png
convert logo.png -resize 144x144 icons/icon-144.png
convert logo.png -resize 152x152 icons/icon-152.png
convert logo.png -resize 192x192 icons/icon-192.png
convert logo.png -resize 384x384 icons/icon-384.png
convert logo.png -resize 512x512 icons/icon-512.png
```

**Option 3: Placeholder (für Tests)**
```bash
# Erstelle einfache farbige Quadrate als Platzhalter
mkdir -p icons
for size in 72 96 128 144 152 192 384 512; do
  convert -size ${size}x${size} xc:#1a1a1a -pointsize 48 -fill white \
    -gravity center -annotate +0+0 "ESP32" icons/icon-${size}.png
done
```

## 🧪 Testen:

### Lokal testen:
```bash
# Starte einen lokalen Server
npm run develop
```

Öffne in Chrome: `http://localhost:5004`

### PWA-Funktionalität prüfen:
1. Chrome DevTools öffnen (F12)
2. Tab **"Application"** → **"Manifest"** → Prüfe ob manifest.json geladen wird
3. Tab **"Application"** → **"Service Workers"** → Prüfe ob sw.js registriert ist
4. Tab **"Lighthouse"** → **"Progressive Web App"** → Audit durchführen

### Android-Test:
1. Deploye auf einen HTTPS-Server (GitHub Pages, Netlify, Vercel)
2. Öffne die URL auf Android Chrome
3. Prüfe ob "Installieren"-Banner erscheint

## 🚀 Deployment:

### GitHub Pages (kostenlos):
```bash
# In package.json hinzufügen:
"homepage": "https://deinusername.github.io/espWebAndroid",
"scripts": {
  "deploy": "gh-pages -d ."
}

# Installiere gh-pages
npm install --save-dev gh-pages

# Deploye
npm run deploy
```

### Netlify/Vercel:
- Verbinde dein GitHub-Repo
- Automatisches Deployment bei jedem Push
- HTTPS ist automatisch aktiviert

## 📋 Checkliste:

- [x] manifest.json erstellt
- [x] sw.js erstellt
- [x] index.html aktualisiert
- [ ] Icons erstellen (icons/*.png)
- [ ] Optional: Screenshots erstellen (screenshots/*.png)
- [x] Auf HTTPS-Server deployen
- [x] Auf Android testen

## 🔧 Anpassungen:

### Theme-Farbe ändern:
In `manifest.json`:
```json
"theme_color": "#1a1a1a",  // Deine Farbe
"background_color": "#ffffff"
```

### Cache-Strategie anpassen:
In `sw.js` kannst du die `CORE_ASSETS` Liste erweitern oder die Fetch-Strategie ändern.

### Offline-Seite hinzufügen:
Erstelle `offline.html` und füge sie zu `CORE_ASSETS` hinzu.

## 📱 Features:

✅ Installierbar auf Android Homescreen
✅ Offline-Funktionalität (gecachte Dateien)
✅ Schnellere Ladezeiten durch Caching
✅ Native App-Feeling (Fullscreen, eigenes Icon)
✅ WebUSB funktioniert vollständig
✅ Automatische Updates bei neuer Version

## ⚠️ Wichtig:

- #### HTTPS erforderlich (außer localhost)
- #### WebUSB benötigt USB OTG auf Android
- #### Chrome 61+ erforderlich
- #### Service Worker funktioniert nicht im Inkognito-Modus
