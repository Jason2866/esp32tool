#!/usr/bin/env node

/**
 * Build standalone Electron-based CLI binaries
 * Creates truly standalone executables that don't require Node.js installation
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Building Electron-based CLI binaries...\n');

// Ensure dist is built
if (!fs.existsSync('dist/cli.js')) {
  console.log('Building TypeScript first...');
  execSync('npm run build', { stdio: 'inherit' });
}

// Copy package.cli.json to package.json temporarily
const originalPackage = fs.readFileSync('package.json', 'utf8');
const cliPackage = fs.readFileSync('package.cli.json', 'utf8');

try {
  // Backup original package.json
  fs.writeFileSync('package.json.backup', originalPackage);
  
  // Use CLI package.json
  fs.writeFileSync('package.json', cliPackage);
  
  // Temporarily swap forge configs
  if (fs.existsSync('forge.config.cjs')) {
    fs.renameSync('forge.config.cjs', 'forge.config.cjs.gui-backup');
  }
  if (fs.existsSync('forge.config.cli.cjs')) {
    fs.renameSync('forge.config.cli.cjs', 'forge.config.cjs');
  }
  
  // Build for current platform
  const platform = process.platform;
  const arch = process.arch;
  
  console.log(`\nBuilding CLI for ${platform}-${arch}...`);
  
  execSync(`npx electron-forge package --platform=${platform} --arch=${arch}`, {
    stdio: 'inherit'
  });
  
  execSync(`npx electron-forge make --platform=${platform} --arch=${arch}`, {
    stdio: 'inherit'
  });
  
  // Move output to out-cli directory and rename files
  if (fs.existsSync('out')) {
    if (fs.existsSync('out-cli')) {
      fs.rmSync('out-cli', { recursive: true, force: true });
    }
    fs.renameSync('out', 'out-cli');
    
    // Rename DMG/ZIP files to include -cli suffix
    const makeDir = path.join('out-cli', 'make');
    if (fs.existsSync(makeDir)) {
      const renameInDir = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
        files.forEach(file => {
          if (file.isFile() && (file.name.endsWith('.dmg') || file.name.endsWith('.zip') || file.name.endsWith('.exe'))) {
            const oldPath = path.join(file.path || file.parentPath, file.name);
            const newName = file.name.replace(/ESP32Tool/, 'ESP32Tool-CLI');
            const newPath = path.join(file.path || file.parentPath, newName);
            if (oldPath !== newPath) {
              fs.renameSync(oldPath, newPath);
              console.log(`Renamed: ${file.name} -> ${newName}`);
            }
          }
        });
      };
      renameInDir(makeDir);
    }
  }
  
  console.log('\n✓ CLI binaries built successfully!');
  console.log('Output: out-cli/make/');
  
} finally {
  // Restore forge configs
  if (fs.existsSync('forge.config.cjs')) {
    fs.renameSync('forge.config.cjs', 'forge.config.cli.cjs');
  }
  if (fs.existsSync('forge.config.cjs.gui-backup')) {
    fs.renameSync('forge.config.cjs.gui-backup', 'forge.config.cjs');
  }
  
  // Restore original package.json
  fs.writeFileSync('package.json', originalPackage);
  if (fs.existsSync('package.json.backup')) {
    fs.unlinkSync('package.json.backup');
  }
}
