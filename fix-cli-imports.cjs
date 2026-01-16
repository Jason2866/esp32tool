const fs = require('fs');
const path = require('path');

if (!fs.existsSync('dist/cli.js')) {
  console.error('Run npm run build first!');
  process.exit(1);
}

function fixImportsInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Determine the relative path depth (how many ../ we need)
  const depth = filePath.split(path.sep).length - 2; // -2 for 'dist' and filename
  const prefix = depth > 0 ? '../'.repeat(depth) : './';
  
  // Fix imports with single quotes: add .js extension to relative imports
  content = content.replace(/from '\.\.\/([^']+)'/g, function(match, moduleName) {
    if (moduleName.endsWith('.js') || moduleName.endsWith('.json')) {
      return match;
    }
    if (moduleName === 'stubs') {
      return `from '../stubs/index.js'`;
    }
    return `from '../${moduleName}.js'`;
  });
  
  content = content.replace(/from '\.\/([^']+)'/g, function(match, moduleName) {
    if (moduleName.endsWith('.js') || moduleName.endsWith('.json')) {
      return match;
    }
    if (moduleName === 'stubs') {
      return `from './stubs/index.js'`;
    }
    return `from './${moduleName}.js'`;
  });
  
  // Fix imports with double quotes
  content = content.replace(/from "\.\.\/([^"]+)"/g, function(match, moduleName) {
    if (moduleName.endsWith('.js') || moduleName.endsWith('.json')) {
      return match;
    }
    if (moduleName === 'stubs') {
      return `from "../stubs/index.js"`;
    }
    return `from "../${moduleName}.js"`;
  });
  
  content = content.replace(/from "\.\/([^"]+)"/g, function(match, moduleName) {
    if (moduleName.endsWith('.js') || moduleName.endsWith('.json')) {
      return match;
    }
    if (moduleName === 'stubs') {
      return `from "./stubs/index.js"`;
    }
    return `from "./${moduleName}.js"`;
  });
  
  // Fix dynamic JSON imports and add .default access
  // Pattern: stubcode = await import("./esp32c3.json", { with: { type: "json" } });
  // Replace with: stubcode = (await import("./esp32c3.json", { with: { type: "json" } })).default;
  content = content.replace(
    /(\w+)\s*=\s*await\s+import\("\.\/([^"]+\.json)",\s*\{\s*with:\s*\{\s*type:\s*"json"\s*\}\s*\}\);/g,
    function(match, varName, jsonFile) {
      return `${varName} = (await import("./${jsonFile}", { with: { type: "json" } })).default;`;
    }
  );
  
  // Also handle JSON imports without .default that were already processed
  // Pattern: stubcode = await import("./esp32c3.json", { with: { type: "json" } });
  // This catches cases where the import is already formatted but missing .default
  content = content.replace(
    /(\w+)\s*=\s*await\s+import\(([^)]+\.json[^)]*)\);/g,
    function(match, varName, importPath) {
      // Skip if already has .default
      if (match.includes('.default')) {
        return match;
      }
      return `${varName} = (await import(${importPath})).default;`;
    }
  );
  
  // Also fix dynamic imports for .js files
  content = content.replace(/import\("\.\/([^"]+)"\)/g, function(match, moduleName) {
    if (moduleName.endsWith('.js')) {
      return match;
    }
    if (moduleName.endsWith('.json')) {
      // Add JSON import assertion for Node.js ES modules
      return `import("./${moduleName}", { with: { type: "json" } })`;
    }
    return `import("./${moduleName}.js")`;
  });
  
  fs.writeFileSync(filePath, content);
}

function fixAllJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Recursively fix subdirectories
      fixAllJsFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'cli-fixed.js') {
      fixImportsInFile(fullPath);
    }
  }
}

console.log('Fixing imports in all .js files...');
fixAllJsFiles('dist');

// Now create cli-fixed.js with shebang
let cliSrc = fs.readFileSync('dist/cli.js', 'utf8');

// Remove shebang if present
if (cliSrc.startsWith('#!')) {
  cliSrc = cliSrc.substring(cliSrc.indexOf('\n') + 1);
}

// Write fixed version with shebang
fs.writeFileSync('dist/cli-fixed.js', '#!/usr/bin/env node\n' + cliSrc);
fs.chmodSync('dist/cli-fixed.js', 0o755);

console.log('CLI built: dist/cli-fixed.js');
