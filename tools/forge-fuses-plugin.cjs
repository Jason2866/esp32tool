const path = require('node:path');
const { PluginBase, namedHookWithTaskFn } = require('@electron-forge/plugin-base');

function getElectronExecutablePath({ appName, basePath, platform }) {
  if (['darwin', 'mas'].includes(platform)) {
    return path.join(basePath, 'MacOS', appName);
  }

  const suffix = platform === 'win32' ? '.exe' : '';
  return path.join(basePath, `${appName}${suffix}`);
}

class FusesPlugin extends PluginBase {
  constructor(fusesConfig) {
    super(fusesConfig);
    this.name = 'fuses';
    this.fusesConfig = fusesConfig ?? {};
  }

  getHooks() {
    return {
      packageAfterCopy: namedHookWithTaskFn(
        async (listrTask, resolvedForgeConfig, resourcesPath, electronVersion, platform, arch) => {
          if (!Object.keys(this.fusesConfig).length) {
            return;
          }

          const applePlatforms = ['darwin', 'mas'];
          const pathToElectronExecutable = getElectronExecutablePath({
            appName: applePlatforms.includes(platform) ? 'Electron' : 'electron',
            basePath: path.resolve(resourcesPath, '../..'),
            platform,
          });

          const osxSignConfig = resolvedForgeConfig.packagerConfig.osxSign;
          const hasOSXSignConfig =
            (typeof osxSignConfig === 'object' && Boolean(Object.keys(osxSignConfig).length)) ||
            Boolean(osxSignConfig);

          const { flipFuses } = await import('@electron/fuses');
          await flipFuses(pathToElectronExecutable, {
            resetAdHocDarwinSignature:
              !hasOSXSignConfig && applePlatforms.includes(platform) && arch === 'arm64',
            ...this.fusesConfig,
          });
        },
        'Flipping Fuses'
      ),
    };
  }
}

module.exports = { FusesPlugin };
