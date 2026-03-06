# PWA Setup for ESP32Tool

## ✅ What was created:

1. **manifest.json** - PWA manifest with app metadata
2. **sw.js** - Service Worker for offline functionality and caching
3. **index.html** - Updated with PWA meta tags and Service Worker registration

## 📱 Installation on Android:

### For Users:
1. Open the website in **Chrome for Android** (version 61+)
2. Tap the **menu** (⋮) in the top right
3. Select **"Add to Home screen"** or **"Install app"**
4. Confirm the installation
5. The app will appear on your home screen

### Requirements:
- Android 5.0+ (Lollipop or higher)
- Chrome for Android 61+
- USB OTG adapter for ESP32 connection
- HTTPS connection (or localhost for testing)

## 🎨 Creating Icons:

You still need app icons! Create an `icons/` folder with the following sizes:

```bash
mkdir icons
```

Required icon sizes:
- icon-72.png (72x72)
- icon-96.png (96x96)
- icon-128.png (128x128)
- icon-144.png (144x144)
- icon-152.png (152x152)
- icon-192.png (192x192) ⭐ Important
- icon-384.png (384x384)
- icon-512.png (512x512) ⭐ Important

### Quick Icon Creation:

**Option 1: Online Tool**
- Go to https://realfavicongenerator.net/
- Upload a square logo (at least 512x512)
- Download all sizes

**Option 2: ImageMagick (CLI)**
```bash
# Install ImageMagick
brew install imagemagick  # macOS
# or: sudo apt install imagemagick  # Linux

# Create all sizes from a source image
convert logo.png -resize 72x72 icons/icon-72.png
convert logo.png -resize 96x96 icons/icon-96.png
convert logo.png -resize 128x128 icons/icon-128.png
convert logo.png -resize 144x144 icons/icon-144.png
convert logo.png -resize 152x152 icons/icon-152.png
convert logo.png -resize 192x192 icons/icon-192.png
convert logo.png -resize 384x384 icons/icon-384.png
convert logo.png -resize 512x512 icons/icon-512.png
```

**Option 3: Placeholder (for testing)**
```bash
# Create simple colored squares as placeholders
mkdir -p icons
for size in 72 96 128 144 152 192 384 512; do
  convert -size ${size}x${size} xc:#1a1a1a -pointsize 48 -fill white \
    -gravity center -annotate +0+0 "ESP32" icons/icon-${size}.png
done
```

## 🧪 Testing:

### Local Testing:
```bash
# Start a local server
npm run develop
```

Open in Chrome: `http://localhost:5004`

### Verifying PWA Functionality:
1. Open Chrome DevTools (F12)
2. Tab **"Application"** → **"Manifest"** → Check that manifest.json is loaded
3. Tab **"Application"** → **"Service Workers"** → Check that sw.js is registered
4. Tab **"Lighthouse"** → **"Progressive Web App"** → Run audit

### Android Testing:
1. Deploy to an HTTPS server (GitHub Pages, Netlify, Vercel)
2. Open the URL in Android Chrome
3. Check if the "Install" banner appears

## 🚀 Deployment:

### GitHub Pages (free):
```bash
# Add to package.json:
"homepage": "https://yourusername.github.io/esp32tool",
"scripts": {
  "deploy": "gh-pages -d ."
}

# Install gh-pages
npm install --save-dev gh-pages

# Deploy
npm run deploy
```

### Netlify/Vercel:
- Connect your GitHub repo
- Automatic deployment on every push
- HTTPS is automatically enabled

## 📋 Checklist:

- [x] manifest.json created
- [x] sw.js created
- [x] index.html updated
- [ ] Create icons (icons/*.png)
- [ ] Optional: Create screenshots (screenshots/*.png)
- [x] Deploy to HTTPS server
- [x] Test on Android

## 🔧 Customization:

### Changing Theme Color:
In `manifest.json`:
```json
"theme_color": "#1a1a1a",  // Your color
"background_color": "#ffffff"
```

### Adjusting Cache Strategy:
In `sw.js` you can extend the `CORE_ASSETS` list or change the fetch strategy.

### Adding an Offline Page:
Create `offline.html` and add it to `CORE_ASSETS`.

## 📱 Features:

✅ Installable on Android home screen
✅ Offline functionality (cached files)
✅ Faster load times through caching
✅ Native app feel (fullscreen, custom icon)
✅ WebUSB fully functional
✅ Automatic updates on new version

## ⚠️ Important:

- #### HTTPS required (except localhost)
- #### WebUSB requires USB OTG on Android
- #### Chrome 61+ required
- #### Service Worker does not work in incognito mode
