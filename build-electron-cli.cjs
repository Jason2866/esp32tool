#!/usr/bin/env node

/**
 * Build standalone Electron-based CLI binaries
 * Creates truly standalone executables that don't require Node.js installation
 * 
 * IMPORTANT: This script temporarily swaps package.json with package.cli.json
 * during the build process, then restores the original package.json.
 * 
 * When releasing a new version:
 * 1. Update version in package.json
 * 2. Update version in package.cli.json (keep in sync!)
 * 3. Run this script to build CLI binaries
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

// Read package files
const originalPackage = fs.readFileSync('package.json', 'utf8');
const cliPackageContent = fs.readFileSync('package.cli.json', 'utf8');

// Parse and sync versions
const originalPkg = JSON.parse(originalPackage);
const cliPkg = JSON.parse(cliPackageContent);

if (originalPkg.version !== cliPkg.version) {
  console.log(`⚠️  Version mismatch detected!`);
  console.log(`   package.json: ${originalPkg.version}`);
  console.log(`   package.cli.json: ${cliPkg.version}`);
  console.log(`   Syncing package.cli.json to ${originalPkg.version}...\n`);
  
  cliPkg.version = originalPkg.version;
}

// Sync dependencies from main package.json to CLI package.json
if (originalPkg.dependencies) {
  if (JSON.stringify(originalPkg.dependencies) !== JSON.stringify(cliPkg.dependencies)) {
    console.log(`⚠️  Dependencies mismatch detected!`);
    console.log(`   Syncing dependencies from package.json to package.cli.json...\n`);
    cliPkg.dependencies = originalPkg.dependencies;
  }
}

// Save synced package.cli.json if changes were made
if (originalPkg.version !== JSON.parse(cliPackageContent).version || 
    JSON.stringify(originalPkg.dependencies) !== JSON.stringify(JSON.parse(cliPackageContent).dependencies)) {
  fs.writeFileSync('package.cli.json', JSON.stringify(cliPkg, null, 2) + '\n');
}

const cliPackage = JSON.stringify(cliPkg, null, 2);

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
  
  // Backup GUI builds if they exist
  let guiBackupPath = null;
  if (fs.existsSync('out')) {
    guiBackupPath = 'out-gui-backup-' + Date.now();
    console.log(`⚠️  Backing up existing GUI builds to ${guiBackupPath}...`);
    fs.renameSync('out', guiBackupPath);
  }
  
  try {
    execSync(`npx electron-forge package --platform=${platform} --arch=${arch}`, {
      stdio: 'inherit'
    });
    
    execSync(`npx electron-forge make --platform=${platform} --arch=${arch}`, {
      stdio: 'inherit'
    });
    
    // Move CLI output to out-cli directory
    if (fs.existsSync('out')) {
      if (fs.existsSync('out-cli')) {
        fs.rmSync('out-cli', { recursive: true, force: true });
      }
      fs.renameSync('out', 'out-cli');
    }
    
    // Restore GUI builds
    if (guiBackupPath && fs.existsSync(guiBackupPath)) {
      console.log('✓ Restoring GUI builds...');
      fs.renameSync(guiBackupPath, 'out');
    }
  } catch (error) {
    // Restore GUI builds even on error
    if (guiBackupPath && fs.existsSync(guiBackupPath)) {
      console.log('⚠️  Restoring GUI builds after error...');
      if (fs.existsSync('out')) {
        fs.rmSync('out', { recursive: true, force: true });
      }
      fs.renameSync(guiBackupPath, 'out');
    }
    throw error;
  }
  
  
  // Rename release files to add -CLI suffix
  const makeDir = path.join('out-cli', 'make');
  if (fs.existsSync(makeDir)) {
    const renameInDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
      files.forEach(file => {
        if (file.isFile()) {
          const oldPath = path.join(file.path || file.parentPath, file.name);
          let newName = file.name;
          
          // Handle different file types
          if (file.name.endsWith('.zip') || file.name.endsWith('.exe')) {
            // Add -CLI before the platform identifier
            newName = file.name.replace(/(ESP32Tool)(-darwin|-linux|-win32)/, '$1-CLI$2');
          } else if (file.name.endsWith('.deb')) {
            // esp32tool_1.2.0_amd64.deb -> esp32tool-cli_1.2.0_amd64.deb
            newName = file.name.replace(/^esp32tool_/, 'esp32tool-cli_');
          } else if (file.name.endsWith('.rpm')) {
            // esp32tool-1.2.0-1.x86_64.rpm -> esp32tool-cli-1.2.0-1.x86_64.rpm
            newName = file.name.replace(/^esp32tool-/, 'esp32tool-cli-');
          }
          
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
