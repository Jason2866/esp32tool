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
    name: 'esp32tool-cli',
    executableName: 'esp32tool',
    asar: true,
    // Output to separate directory
    out: 'out-cli',
    // CLI-specific entry point
    electronZipDir: undefined,
    // Ensure consistent executable name across platforms
    win32metadata: {
      FileDescription: 'ESP32Tool CLI',
      ProductName: 'ESP32Tool CLI',
    },
    appBundleId: 'com.esp32tool.cli',
    appCategoryType: 'public.app-category.developer-tools',
    // Override main entry point for CLI
    extraResource: [],
    // Files to exclude from the app
    ignore: [
      /^\/src\/(?!wasm)/,  // Exclude src/ but keep src/wasm/
      /^\/script/,
      /^\/\.github/,
      /^\/tools/,
      /^\/electron\/main\.cjs$/,  // Exclude GUI main
      /^\/index\.html$/,  // Exclude GUI HTML
      /^\/css/,
      /^\/icons/,
      /^\/screenshots/,
      /\.git/,
      /\.eslint/,
      /\.prettier/,
      /tsconfig\.json/,
      /rollup\.config\.(js|mjs)$/,
      /\.md$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
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
