const { app, BrowserWindow, Menu, session, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// Only required for Windows Squirrel installer
if (process.platform === 'win32') {
  try {
    if (require('electron-squirrel-startup')) {
      app.quit();
    }
  } catch (e) {
    // Module not available, ignore
  }
}

let mainWindow;

// Store granted serial port devices
const grantedDevices = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'icons', 'icon.png'),
    title: 'ESP32Tool',
    autoHideMenuBar: false,
  });

  // Load the index.html of the app
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Setup serial port handlers for this window's session
  setupSerialPortHandlers(mainWindow.webContents.session);
}

function setupSerialPortHandlers(ses) {
  const isLikelyEspPort = (port) => {
    const name = `${port?.displayName || ''} ${port?.portName || ''}`.toLowerCase();
    return (
      name.includes('cp2102') ||
      name.includes('cp2103') ||
      name.includes('cp2104') ||
      name.includes('cp2105') ||
      name.includes('cp2108') ||
      name.includes('ch9102') ||
      name.includes('ch9104') ||
      name.includes('ch340') ||
      name.includes('ch341') ||
      name.includes('ch343') ||
      name.includes('ftdi') ||
      name.includes('ft232') ||
      name.includes('usb') ||
      name.includes('uart') ||
      name.includes('silicon labs') ||
      name.includes('esp32') ||
      name.includes('esp8266') ||
      name.includes('esp')
    );
  };

  const getPortLabel = (port) => port?.displayName || port?.portName || port?.portId || 'Unknown port';

  const getPortButtonLabel = (port, isRecommended = false) => {
    const shortId = port?.portName || port?.displayName || port?.portId || 'Unknown';
    return isRecommended ? `${shortId} (Recommended)` : shortId;
  };

  const toHexId = (value) =>
    typeof value === 'number' ? `0x${value.toString(16).toUpperCase().padStart(4, '0')}` : null;

  // Guard against Electron re-firing select-serial-port while a dialog is open
  let activeSelectionId = 0;

  // Handle serial port selection - shows when navigator.serial.requestPort() is called
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();

    // Filter to only show ESP-compatible ports
    const espPorts = (portList || []).filter(isLikelyEspPort);

    if (espPorts.length === 0) {
      callback('');
      return;
    }

    // Single matching port - auto-select
    if (espPorts.length === 1) {
      callback(espPorts[0].portId);
      return;
    }

    // Track this selection so stale dialog results are ignored
    const mySelectionId = ++activeSelectionId;

    const buttonLabels = espPorts.map((port) => getPortButtonLabel(port));
    const cancelIndex = buttonLabels.length;

    const ownerWindow = BrowserWindow.fromWebContents(webContents) || mainWindow;
    dialog.showMessageBox(ownerWindow, {
      type: 'question',
      title: 'ESP32Tool',
      message: 'Select the serial port for your ESP device.',
      buttons: [...buttonLabels, 'Cancel'],
      defaultId: 0,
      cancelId: cancelIndex,
      noLink: true,
    }).then((result) => {
      // Ignore if a newer select-serial-port event superseded this one
      if (mySelectionId !== activeSelectionId) return;
      const selectedPort = espPorts[result.response];
      callback(selectedPort ? selectedPort.portId : '');
    });
  });

  ses.on('serial-port-added', (event, port) => {
    console.log('Serial port added:', port);
  });

  ses.on('serial-port-removed', (event, port) => {
    console.log('Serial port removed:', port);
  });

  ses.setPermissionCheckHandler(() => true);

  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial' && details.device) {
      grantedDevices.set(details.device.deviceId, details.device);
    }
    return true;
  });
}

// Create application menu
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About ESP32Tool',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/Jason2866/esp32tool');
          }
        },
        {
          label: 'ESP32 Documentation',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://docs.espressif.com/');
          }
        }
      ]
    }
  ];

  // macOS specific menu adjustments
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
  createMenu();
  createWindow();

  app.on('activate', () => {
    // On macOS re-create a window when dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================
// IPC Handlers for File Operations
// ============================================

// Save file dialog and write data
ipcMain.handle('save-file', async (event, { data, defaultFilename, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultFilename,
    filters: filters || [
      { name: 'Binary Files', extensions: ['bin'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  try {
    // Convert data to Buffer if it's a Uint8Array
    const buffer = Buffer.from(data);
    fs.writeFileSync(result.filePath, buffer);
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Open file dialog and read data
ipcMain.handle('open-file', async (event, { filters }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [
      { name: 'Binary Files', extensions: ['bin'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  try {
    const filePath = result.filePaths[0];
    const data = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    return { 
      success: true, 
      filePath, 
      filename,
      data: Array.from(data) // Convert Buffer to array for IPC transfer
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Show input dialog (replacement for prompt())
ipcMain.handle('show-prompt', async (event, { message, defaultValue }) => {
  // Use a simple approach - return the default value
  // In Electron, we use the save dialog instead of prompt
  return defaultValue;
});

// Show message box
ipcMain.handle('show-message', async (event, { type, title, message, buttons }) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: type || 'info',
    title: title || 'ESP32Tool',
    message: message,
    buttons: buttons || ['OK']
  });
  return result.response;
});

// Show confirm dialog
ipcMain.handle('show-confirm', async (event, { message }) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Confirm',
    message: message,
    buttons: ['OK', 'Cancel']
  });
  return result.response === 0; // true if OK clicked
});
