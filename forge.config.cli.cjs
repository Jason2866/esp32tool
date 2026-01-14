const { FusesPlugin } = require('./tools/forge-fuses-plugin.cjs');

// @electron/fuses@2 is ESM-only; keep Forge config in CJS by inlining the enum values.
const FuseVersion = { V1: '1' };
const FuseV1Options = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
};

module.exports = {
  packagerConfig: {
    name: 'ESP32Tool',
    executableName: 'esp32tool',
    asar: true,
    // Output to separate directory
    out: 'out-cli',
    // CLI-specific entry point
    electronZipDir: undefined,
    // Ensure consistent executable name across platforms
    win32metadata: {
      FileDescription: 'ESP32Tool',
      ProductName: 'ESP32Tool',
    },
    appBundleId: 'com.esp32tool',
    appCategoryType: 'public.app-category.developer-tools',
    // Override main entry point for CLI
    extraResource: [],
    // Files to exclude from the app
    ignore: (filePath) => {
      if (!filePath) return false;
      
      // Always keep these
      if (filePath === '/package.json') return false;
      if (filePath === '/electron' || filePath === '/electron/cli-main.cjs') return false;
      if (filePath === '/dist' || (filePath.startsWith('/dist/') && !filePath.startsWith('/dist/web/') && filePath !== '/dist/index.js' && filePath !== '/dist/index.d.ts')) return false;
      
      // Let Electron Forge handle node_modules - don't ignore them
      if (filePath.startsWith('/node_modules/')) return false;
      
      // Ignore everything else (GUI files, source files, etc.)
      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: 'esp32tool',
          bin: 'esp32tool',
          maintainer: 'Johann Obermeier',
          homepage: 'https://github.com/Jason2866/esp32tool',
          categories: ['Development', 'Utility'],
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          name: 'esp32tool',
          bin: 'esp32tool',
          homepage: 'https://github.com/Jason2866/esp32tool',
          categories: ['Development', 'Utility'],
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
