#!/usr/bin/env node
/**
 * Build single executable binaries for all platforms
 * Creates self-contained executables that include Node.js + app + dependencies
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');

const packageJson = require('./package.json');
const VERSION = packageJson.version;
const NODE_VERSION = packageJson.engines.node.replace(/[^\d.]/g, '').split('.')[0]; // Extract major version

console.log(`Building ESP32Tool CLI v${VERSION} single executables...\n`);

// Create binaries directory
const binariesDir = path.join(__dirname, 'binaries');
if (!fs.existsSync(binariesDir)) {
  fs.mkdirSync(binariesDir, { recursive: true });
}

// Build the app first
console.log('1. Building application...');
execSync('npm run build', { stdio: 'inherit' });

/**
 * Get all dependencies recursively from package.json
 */
function getAllDependencies() {
  const dependencies = new Set();
  
  // Add direct dependencies from package.json
  if (packageJson.dependencies) {
    Object.keys(packageJson.dependencies).forEach(dep => dependencies.add(dep));
  }
  
  // Add scoped packages that are dependencies of our dependencies
  const nodeModulesDir = path.join(__dirname, 'node_modules');
  
  // Helper to recursively find dependencies
  function addDepsRecursively(moduleName) {
    const modulePath = path.join(nodeModulesDir, moduleName);
    if (!fs.existsSync(modulePath)) return;
    
    const modulePackageJson = path.join(modulePath, 'package.json');
    if (fs.existsSync(modulePackageJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(modulePackageJson, 'utf8'));
        if (pkg.dependencies) {
          Object.keys(pkg.dependencies).forEach(dep => {
            if (!dependencies.has(dep)) {
              dependencies.add(dep);
              addDepsRecursively(dep);
            }
          });
        }
      } catch (err) {
        // Ignore invalid package.json
      }
    }
  }
  
  // Recursively add dependencies
  Array.from(dependencies).forEach(dep => addDepsRecursively(dep));
  
  return Array.from(dependencies);
}

/**
 * Create bundle directory with all necessary files
 */
function createBundle() {
  const bundleDir = path.join(__dirname, '.bundle-temp');
  
  // Clean up old bundle
  if (fs.existsSync(bundleDir)) {
    fs.rmSync(bundleDir, { recursive: true });
  }
  
  fs.mkdirSync(bundleDir, { recursive: true });
  
  console.log('2. Creating bundle...');
  
  // Copy dist
  fs.cpSync(path.join(__dirname, 'dist'), path.join(bundleDir, 'dist'), { recursive: true });
  
  // Get all dependencies from package.json
  const modules = getAllDependencies();
  
  console.log(`   Bundling ${modules.length} dependencies...`);
  
  const nodeModulesDir = path.join(bundleDir, 'node_modules');
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  
  modules.forEach(mod => {
    const src = path.join(__dirname, 'node_modules', mod);
    const dest = path.join(nodeModulesDir, mod);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  });
  
  // Copy package.json
  fs.copyFileSync(
    path.join(__dirname, 'package.json'),
    path.join(bundleDir, 'package.json')
  );
  
  return bundleDir;
}

/**
 * Create launcher script for Unix (macOS/Linux)
 */
function createUnixLauncher(bundleDir) {
  const launcher = `#!/bin/bash
# ESP32Tool CLI - Self-contained launcher

# Get the directory where this script is located
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js not found"
    echo "Please install Node.js ${NODE_VERSION}+ from https://nodejs.org/"
    exit 1
fi

# Check Node.js version
CURRENT_NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$CURRENT_NODE_VERSION" -lt ${NODE_VERSION} ]; then
    echo "Error: Node.js ${NODE_VERSION}+ required (found: $(node -v))"
    echo "Please upgrade Node.js from https://nodejs.org/"
    exit 1
fi

# Run CLI
cd "$DIR"
exec node dist/cli-fixed.js "$@"
`;
  
  fs.writeFileSync(path.join(bundleDir, 'esp32tool'), launcher);
  fs.chmodSync(path.join(bundleDir, 'esp32tool'), 0o755);
}

/**
 * Create launcher script for Windows
 */
function createWindowsLauncher(bundleDir) {
  const launcher = `@echo off
REM ESP32Tool CLI - Self-contained launcher

REM Get the directory where this script is located
set DIR=%~dp0

REM Check for Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js not found
    echo Please install Node.js ${NODE_VERSION}+ from https://nodejs.org/
    exit /b 1
)

REM Run CLI
cd /d "%DIR%"
node dist\\cli-fixed.js %*
`;
  
  fs.writeFileSync(path.join(bundleDir, 'esp32tool.bat'), launcher);
}

/**
 * Create self-extracting archive for Unix using makeself
 */
function createUnixBinary(bundleDir, platform) {
  console.log(`3. Creating ${platform} binary...`);
  
  const outputFile = path.join(binariesDir, `esp32tool-${platform}`);
  
  try {
    // Check if makeself is available
    try {
      execSync('which makeself', { stdio: 'pipe' });
    } catch {
      console.error(`   ✗ Skipped: makeself not installed (install with: brew install makeself / apt install makeself)`);
      return;
    }

    // Create makeself archive with .run extension
    const runFile = `${outputFile}.run`;
    execSync(
      `makeself --notemp "${bundleDir}" "${runFile}" "ESP32Tool CLI v${VERSION}" ./esp32tool`,
      { stdio: 'inherit' }
    );
    
    // Create wrapper script that adds -- automatically
    const runFileName = path.basename(runFile);
    const wrapper = `#!/bin/bash
# ESP32Tool CLI Wrapper

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/${runFileName}" -- "$@"
`;
    
    fs.writeFileSync(outputFile, wrapper);
    fs.chmodSync(outputFile, 0o755);
    
    console.log(`   ✓ Created: ${outputFile}`);
  } catch (err) {
    console.error(`   ✗ Failed: ${err.message}`);
  }
}

/**
 * Create ZIP archive for Windows
 */
function createWindowsBinary(bundleDir) {
  console.log('3. Creating Windows binary...');
  
  const outputFile = path.join(binariesDir, `esp32tool-win-x64.zip`);
  
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      console.log(`   ✓ Created: ${outputFile}`);
      resolve();
    });
    
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(bundleDir, false);
    archive.finalize();
  });
}

/**
 * Main build process
 */
async function main() {
  try {
    // Create bundle
    const bundleDir = createBundle();
    
    // Create launchers
    createUnixLauncher(bundleDir);
    createWindowsLauncher(bundleDir);
    
    // Create binaries for each platform
    createUnixBinary(bundleDir, 'macos');
    createUnixBinary(bundleDir, 'linux-x64');
    await createWindowsBinary(bundleDir);
    
    // Clean up
    fs.rmSync(bundleDir, { recursive: true });
    
    console.log('\n✓ All binaries created!\n');
    console.log('Files in ./binaries/:');
    fs.readdirSync(binariesDir).forEach(file => {
      const stats = fs.statSync(path.join(binariesDir, file));
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      console.log(`  - ${file} (${sizeMB} MB)`);
    });
    
    console.log('\nUsage:');
    console.log('  macOS:   ./binaries/esp32tool-macos list-ports');
    console.log('  Linux:   ./binaries/esp32tool-linux-x64 list-ports');
    console.log('  Windows: Extract zip, then: esp32tool.bat list-ports');
    console.log(`\nNote: Requires Node.js ${NODE_VERSION}+ on target system`);
    
  } catch (error) {
    console.error('\nError:', error.message);
    process.exit(1);
  }
}

main();
