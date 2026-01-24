// Update service worker cache version from package.json
const fs = require('fs');
const path = require('path');

// Read package.json version
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const version = packageJson.version;

// Read sw.js
const swPath = path.join(__dirname, 'sw.js');
let swContent = fs.readFileSync(swPath, 'utf8');

// Replace CACHE_NAME version
const cacheNameRegex = /const CACHE_NAME = ['"]esp32tool-v[\d.]+['"]/;
const newCacheName = `const CACHE_NAME = 'esp32tool-v${version}'`;

if (cacheNameRegex.test(swContent)) {
  swContent = swContent.replace(cacheNameRegex, newCacheName);
  fs.writeFileSync(swPath, swContent, 'utf8');
  console.log(`✓ Updated sw.js CACHE_NAME to esp32tool-v${version}`);
} else {
  console.error('✗ Could not find CACHE_NAME in sw.js');
  process.exit(1);
}
