/**
 * Electron-based CLI - Headless Electron app for CLI operations
 * This provides a truly standalone CLI without requiring Node.js installation
 */

const { app } = require('electron');
const path = require('path');

// Prevent Electron from showing any windows
app.dock?.hide(); // macOS
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

// Get CLI arguments (skip electron executable and script path)
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2);

// Import and run CLI when Electron is ready
app.whenReady().then(async () => {
  try {
    // Dynamically import the CLI module
    const cliPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'dist', 'cli.js')
      : path.join(__dirname, '..', 'dist', 'cli.js');
    
    // Set process.argv to match CLI expectations
    // In packaged app: argv[0] is the executable path
    // We want: ['node', 'esp32tool', ...actualArgs]
    const actualArgs = cliArgs;
    process.argv = ['node', 'esp32tool', ...actualArgs];
    
    // Import CLI module
    const cliModule = await import('file://' + cliPath);
    
    // Run the CLI
    await cliModule.runCLI();
    
    // Exit successfully
    app.exit(0);
  } catch (error) {
    console.error('CLI Error:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    app.exit(1);
  }
});

// Handle app activation (macOS)
app.on('activate', () => {
  // Do nothing - we're a CLI app
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  // Do nothing - we don't have windows
});

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  app.exit(1);
});
