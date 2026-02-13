// Import WebUSB serial support for Android compatibility
import { WebUSBSerial, requestSerialPort } from './webusb-serial.js';
import { ESP32ToolConsole } from './console.js';

// Make requestSerialPort available globally for esptool.js
// Use defensive assignment to avoid accidental overwrites
if (!globalThis.requestSerialPort) {
  globalThis.requestSerialPort = requestSerialPort;
}

// Utility functions imported from esptool module
let toHex, formatMacAddr, sleep;

// Load utilities from esptool package
window.esptoolPackage.then((esptoolMod) => {
  toHex = esptoolMod.toHex;
  formatMacAddr = esptoolMod.formatMacAddr;
  sleep = esptoolMod.sleep;
});

let espStub;
let esp32s2ReconnectInProgress = false;
let currentLittleFS = null;
let currentLittleFSPartition = null;
let currentLittleFSPath = '/';
let currentLittleFSBlockSize = 4096;
let currentFilesystemType = null; // 'littlefs', 'fatfs', or 'spiffs'
let littlefsModulePromise = null; // Cache for LittleFS WASM module
let lastReadFlashData = null; // Store last read flash data for ESP8266
let currentChipName = null; // Store chip name globally
let currentMacAddr = null; // Store MAC address globally
let isConnected = false; // Track connection state
let consoleInstance = null; // ESP32ToolConsole instance
let baudRateBeforeConsole = null; // Store baudrate before opening console
let espLoaderBeforeConsole = null; // Store original ESPLoader before console
let chipFamilyBeforeConsole = null; // Store chipFamily before opening console
let consoleResetHandler = null;
let consoleCloseHandler = null;
let consoleBootloaderHandlerModule = null;

/**
 * Get display name for current filesystem type
 */
function getFilesystemDisplayName() {
  if (!currentFilesystemType) return 'Filesystem';
  switch (currentFilesystemType) {
    case 'littlefs': return 'LittleFS';
    case 'fatfs': return 'FatFS';
    case 'spiffs': return 'SPIFFS';
    default: return 'Filesystem';
  }
}

/**
 * Clear all cached data and state on disconnect
 */
function clearAllCachedData() {
  // Close filesystem if open
  if (currentLittleFS) {
    try {
      // Only call destroy if it exists (LittleFS has it, FatFS/SPIFFS don't)
      if (typeof currentLittleFS.destroy === 'function') {
        currentLittleFS.destroy();
      }
    } catch (e) {
      debugMsg('Error destroying filesystem: ' + e);
    }
  }
  
  // Reset filesystem state
  currentLittleFS = null;
  currentLittleFSPartition = null;
  currentLittleFSPath = '/';
  currentLittleFSBlockSize = 4096;
  currentFilesystemType = null;
  lastReadFlashData = null;
  currentChipName = null;
  currentMacAddr = null;
  
  // Hide filesystem manager
  littlefsManager.classList.add('hidden');
  
  // Clear partition list
  partitionList.innerHTML = '';
  partitionList.classList.add('hidden');
  
  // Show the Read Partition Table button again
  butReadPartitions.classList.remove('hidden');
  
  // Hide Detect FS button
  butDetectFS.classList.add('hidden');
  
  // Hide Open FS Manager button (if it exists)
  if (butOpenFSManager) {
    butOpenFSManager.classList.add('hidden');
  }
  
  // Hide ESP8266 info (if it exists)
  const esp8266Info = document.getElementById('esp8266Info');
  if (esp8266Info) {
    esp8266Info.classList.add('hidden');
  }
  
  // Clear file input
  if (littlefsFileInput) {
    littlefsFileInput.value = '';
  }
  
  // Reset buttons
  butLittlefsUpload.disabled = true;
  
  // Clear any cached module promises
  littlefsModulePromise = null;
  
  logMsg('All cached data cleared');
}

const baudRates = [2000000, 1500000, 921600, 500000, 460800, 230400, 153600, 128000, 115200];

// Advanced read flash parameters
// chunkSize: Amount of data to request from ESP in one command (in KB)
const chunkSizes = [
  { label: "4 KB", value: 0x1000 },
  { label: "8 KB", value: 0x2000 },
  { label: "16 KB (WebUSB)", value: 0x4000 },
  { label: "64 KB", value: 0x10000 },
  { label: "128 KB (Desktop)", value: 0x20000 },
  { label: "256 KB", value: 0x40000 }
];

// blockSize: Size of each data block sent by ESP (in bytes)
const blockSizes = [
  { label: "31 B (Android)", value: 31 },
  { label: "62 B", value: 62 },
  { label: "124 B", value: 124 },
  { label: "248 B (CDC)", value: 248 },
  { label: "256 B", value: 256 },
  { label: "496 B", value: 496 },
  { label: "512 B", value: 512 },
  { label: "992 B", value: 992 },
  { label: "1024 B", value: 1024 },
  { label: "1984 B", value: 1984 },
  { label: "2024 B", value: 2024 },
  { label: "3968 B (Desktop)", value: 3968 }
];

// maxInFlight: Maximum unacknowledged bytes (in bytes)
const maxInFlights = [
  { label: "31 B (Android)", value: 31 },
  { label: "62 B", value: 62 },
  { label: "124 B", value: 124 },
  { label: "248 B (Android CDC)", value: 248 },
  { label: "512 B", value: 512 },
  { label: "992 B", value: 992 },
  { label: "1024 B", value: 1024 },
  { label: "1984 B", value: 1984 },
  { label: "2024 B", value: 2024 },
  { label: "3968 B", value: 3968 },
  { label: "4096 B", value: 4096 },
  { label: "7936 B", value: 7936 },
  { label: "8192 B", value: 8192 },
  { label: "15872 B (Desktop)", value: 15872 },
  { label: "31744 B", value: 31744 },
  { label: "63488 B", value: 63488 },
  { label: "126976 B", value: 126976 },
  { label: "253952 B", value: 253952 }
];

// Check if running in Electron
const isElectron = window.electronAPI && window.electronAPI.isElectron;

const maxLogLength = 100;
const log = document.getElementById("log");
const butConnect = document.getElementById("butConnect");
const baudRateSelect = document.getElementById("baudRate");
const advancedMode = document.getElementById("advanced");
const advancedRow = document.querySelector(".advanced-row");
const main = document.querySelector(".main");
const chunkSizeSelect = document.getElementById("chunkSize");
const blockSizeSelect = document.getElementById("blockSize");
const maxInFlightSelect = document.getElementById("maxInFlight");
const butClear = document.getElementById("butClear");
const butErase = document.getElementById("butErase");
const butProgram = document.getElementById("butProgram");
const butReadFlash = document.getElementById("butReadFlash");
const readOffset = document.getElementById("readOffset");
const readSize = document.getElementById("readSize");
const readProgress = document.getElementById("readProgress");
const butReadPartitions = document.getElementById("butReadPartitions");
const butDetectFS = document.getElementById("butDetectFS");
const butOpenFSManager = document.getElementById("butOpenFSManager");
const partitionList = document.getElementById("partitionList");
const littlefsManager = document.getElementById("littlefsManager");
const littlefsPartitionName = document.getElementById("littlefsPartitionName");
const littlefsPartitionSize = document.getElementById("littlefsPartitionSize");
const littlefsUsageBar = document.getElementById("littlefsUsageBar");
const littlefsUsageText = document.getElementById("littlefsUsageText");
const littlefsDiskVersion = document.getElementById("littlefsDiskVersion");
const littlefsFileList = document.getElementById("littlefsFileList");
const littlefsBreadcrumb = document.getElementById("littlefsBreadcrumb");
const butLittlefsUp = document.getElementById("butLittlefsUp");
const butLittlefsRefresh = document.getElementById("butLittlefsRefresh");
const butLittlefsBackup = document.getElementById("butLittlefsBackup");
const butLittlefsWrite = document.getElementById("butLittlefsWrite");
const butLittlefsClose = document.getElementById("butLittlefsClose");
const littlefsFileInput = document.getElementById("littlefsFileInput");
const butLittlefsUpload = document.getElementById("butLittlefsUpload");
const butLittlefsMkdir = document.getElementById("butLittlefsMkdir");
const autoscroll = document.getElementById("autoscroll");
const consoleSwitch = document.getElementById("console");
const consoleContainer = document.getElementById("console-container");
const lightSS = document.getElementById("light");
const darkSS = document.getElementById("dark");
const darkMode = document.getElementById("darkmode");
const debugMode = document.getElementById("debugmode");
const showLog = document.getElementById("showlog");
const firmware = document.querySelectorAll(".upload .firmware input");
const progress = document.querySelectorAll(".upload .progress-bar");
const offsets = document.querySelectorAll(".upload .offset");
const appDiv = document.getElementById("app");
const fileViewerModal = document.getElementById("fileViewerModal");
const fileViewerTitle = document.getElementById("fileViewerTitle");
const fileViewerPath = document.getElementById("fileViewerPath");
const fileViewerSize = document.getElementById("fileViewerSize");
const fileViewerText = document.getElementById("fileViewerText");
const butCloseFileViewer = document.getElementById("butCloseFileViewer");
const butDownloadFromViewer = document.getElementById("butDownloadFromViewer");
const tabText = document.getElementById("tabText");
const tabHex = document.getElementById("tabHex");

let currentViewedFile = null;
let currentViewedFileData = null;

// Mobile detection
function isMobileDevice() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  
  // Check for mobile user agents
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
  const isMobileUA = mobileRegex.test(userAgent);
  
  // Check for touch support
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  
  // Check screen size
  const isSmallScreen = window.innerWidth <= 768;
  
  return isMobileUA || (hasTouch && isSmallScreen);
}

/**
 * Detect if we're using WebUSB (mobile/Android) or Web Serial (desktop)
 * WebUSB is typically used on Android devices
 * Web Serial is used on desktop browsers
 */
function isUsingWebUSB() {
  // If we have an active connection, check the port's isWebUSB property
  if (espStub && espStub.port && typeof espStub.port.isWebUSB !== 'undefined') {
    return espStub.port.isWebUSB === true;
  }
  
  // Fallback: Check if we're on a mobile device (likely using WebUSB)
  if (isMobileDevice()) {
    return true;
  }
  
  // Check if Web Serial is NOT available but USB is (WebUSB only)
  if (!("serial" in navigator) && "usb" in navigator) {
    return true;
  }
  
  // Default to Web Serial (desktop)
  return false;
}

/**
 * Get default advanced parameters based on environment
 * Desktop (Web Serial): Higher values for better performance
 * Mobile/WebUSB: Lower values for compatibility
 */
function getDefaultAdvancedParams() {
  const isWebUSB = isUsingWebUSB();
  
  return {
    chunkSize: isWebUSB ? 0x4000 : 0x20000,  // 16 KB for WebUSB, 128 KB for Desktop
    blockSize: isWebUSB ? 248 : 3968,         // 248 B for WebUSB, 3968 B for Desktop
    maxInFlight: isWebUSB ? 248 : 15872       // 248 B for WebUSB, 15872 B for Desktop
  };
}

// Update mobile classes and padding
function updateMobileClasses() {
  const isMobile = isMobileDevice();
  
  if (isMobile) {
    document.body.classList.add('mobile-device');
    document.body.classList.add('no-hover');
  } else {
    document.body.classList.remove('mobile-device');
    document.body.classList.remove('no-hover');
  }
  
  // Update main padding to match header height
  updateMainPadding();
}

// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Debounced resize handler
const debouncedUpdateMobileClasses = debounce(updateMobileClasses, 250);

// Apply mobile class on load
updateMobileClasses();

// Update on resize and orientation change
window.addEventListener('resize', debouncedUpdateMobileClasses);
window.addEventListener('orientationchange', debouncedUpdateMobileClasses);

document.addEventListener("DOMContentLoaded", () => {
  butConnect.addEventListener("click", () => {
    clickConnect().catch(async (e) => {
      debugMsg('Connection error: ' + e);
      errorMsg(e.message || e);
      if (espStub) {
        await espStub.disconnect();
      }
      toggleUIConnected(false);
    });
  });
  butClear.addEventListener("click", clickClear);
  butErase.addEventListener("click", clickErase);
  butProgram.addEventListener("click", clickProgram);
  butReadFlash.addEventListener("click", clickReadFlash);
  butReadPartitions.addEventListener("click", clickReadPartitions);
  butDetectFS.addEventListener("click", clickDetectFS);
  butOpenFSManager.addEventListener("click", clickOpenFSManager);
  butLittlefsRefresh.addEventListener("click", clickLittlefsRefresh);
  butLittlefsBackup.addEventListener("click", clickLittlefsBackup);
  butLittlefsWrite.addEventListener("click", clickLittlefsWrite);
  butLittlefsClose.addEventListener("click", clickLittlefsClose);
  butLittlefsUp.addEventListener("click", clickLittlefsUp);
  butLittlefsUpload.addEventListener("click", clickLittlefsUpload);
  butLittlefsMkdir.addEventListener("click", clickLittlefsMkdir);
  butCloseFileViewer.addEventListener("click", closeFileViewer);
  butDownloadFromViewer.addEventListener("click", downloadFromViewer);
  tabText.addEventListener("click", () => switchViewerTab('text'));
  tabHex.addEventListener("click", () => switchViewerTab('hex'));
  littlefsFileInput.addEventListener("change", () => {
    butLittlefsUpload.disabled = !littlefsFileInput.files.length;
  });
  for (let i = 0; i < firmware.length; i++) {
    firmware[i].addEventListener("change", checkFirmware);
  }
  for (let i = 0; i < offsets.length; i++) {
    offsets[i].addEventListener("change", checkProgrammable);
  }
  
  // Initialize upload rows visibility - only show first row
  updateUploadRowsVisibility();
  
  autoscroll.addEventListener("click", clickAutoscroll);
  consoleSwitch.addEventListener("click", clickConsole);
  baudRateSelect.addEventListener("change", changeBaudRate);
  advancedMode.addEventListener("change", clickAdvancedMode);
  chunkSizeSelect.addEventListener("change", changeAdvancedParam);
  blockSizeSelect.addEventListener("change", changeAdvancedParam);
  maxInFlightSelect.addEventListener("change", changeAdvancedParam);
  darkMode.addEventListener("click", clickDarkMode);
  debugMode.addEventListener("click", clickDebugMode);
  showLog.addEventListener("click", clickShowLog);
  window.addEventListener("error", function (event) {
    console.log("Got an uncaught error: ", event.error);
  });

  // Check for Web Serial or WebUSB support
  if ("serial" in navigator || "usb" in navigator) {
    const notSupported = document.getElementById("notSupported");
    notSupported.classList.add("hidden");
  }

  initBaudRate();
  initAdvancedParams();
  loadAllSettings();
  updateTheme();
  logMsg("ESP32Tool loaded.");
  
  // Set initial main padding based on header height
  updateMainPadding();
});

function initBaudRate() {
  for (let rate of baudRates) {
    var option = document.createElement("option");
    option.text = rate + " Baud";
    option.value = rate;
    baudRateSelect.add(option);
  }
}

function initAdvancedParams() {
  // Get default values based on environment (Desktop vs WebUSB)
  const defaults = getDefaultAdvancedParams();
  
  // Initialize chunkSize dropdown
  for (let item of chunkSizes) {
    const option = document.createElement("option");
    option.text = item.label;
    option.value = item.value;
    chunkSizeSelect.add(option);
  }
  // Set default: 16 KB for WebUSB, 128 KB for Desktop
  chunkSizeSelect.value = defaults.chunkSize;

  // Initialize blockSize dropdown
  for (let item of blockSizes) {
    const option = document.createElement("option");
    option.text = item.label;
    option.value = item.value;
    blockSizeSelect.add(option);
  }
  // Set default: 248 B for WebUSB, 3968 B for Desktop
  blockSizeSelect.value = defaults.blockSize;

  // Initialize maxInFlight dropdown
  for (let item of maxInFlights) {
    const option = document.createElement("option");
    option.text = item.label;
    option.value = item.value;
    maxInFlightSelect.add(option);
  }
  // Set default: 248 B for WebUSB, 15872 B for Desktop
  maxInFlightSelect.value = defaults.maxInFlight;
}

/**
 * Update advanced parameters after connection based on actual port type
 * This ensures we use optimal values for WebUSB vs Web Serial
 */
function updateAdvancedParamsForConnection() {
  // Get the correct defaults based on actual connection
  const defaults = getDefaultAdvancedParams();
  
  // Get current values
  const currentChunkSize = parseInt(chunkSizeSelect.value);
  const currentBlockSize = parseInt(blockSizeSelect.value);
  const currentMaxInFlight = parseInt(maxInFlightSelect.value);
  
  // Check if values are at old defaults (need updating)
  const oldWebUSBDefaults = { chunkSize: 0x4000, blockSize: 248, maxInFlight: 248 };
  const oldDesktopDefaults = { chunkSize: 0x40000, blockSize: 3968, maxInFlight: 15872 };
  
  const isAtWebUSBDefaults = 
    currentChunkSize === oldWebUSBDefaults.chunkSize &&
    currentBlockSize === oldWebUSBDefaults.blockSize &&
    currentMaxInFlight === oldWebUSBDefaults.maxInFlight;
    
  const isAtDesktopDefaults = 
    currentChunkSize === oldDesktopDefaults.chunkSize &&
    currentBlockSize === oldDesktopDefaults.blockSize &&
    currentMaxInFlight === oldDesktopDefaults.maxInFlight;
  
  // Only update if at defaults (user hasn't customized)
  if (isAtWebUSBDefaults || isAtDesktopDefaults) {
    chunkSizeSelect.value = defaults.chunkSize;
    blockSizeSelect.value = defaults.blockSize;
    maxInFlightSelect.value = defaults.maxInFlight;
    
    // Save the new values
    saveSetting("chunkSize", defaults.chunkSize);
    saveSetting("blockSize", defaults.blockSize);
    saveSetting("maxInFlight", defaults.maxInFlight);
    
    const connectionType = isUsingWebUSB() ? "WebUSB" : "Web Serial";
    debugMsg(`Advanced parameters updated for ${connectionType} connection`);
  }
}

function logMsg(text) {
  log.innerHTML += text + "<br>";

  // Remove old log content
  if (log.textContent.split("\n").length > maxLogLength + 1) {
    let logLines = log.innerHTML.replace(/(\n)/gm, "").split("<br>");
    log.innerHTML = logLines.splice(-maxLogLength).join("<br>\n");
  }

  if (autoscroll.checked) {
    log.scrollTop = log.scrollHeight;
  }
}

function debugMsg(...args) {
  if (!debugMode.checked) {
    return;
  }

  let prefix = "";
  for (let arg of args) {
    if (arg === undefined) {
      logMsg(prefix + "undefined");
    } else if (arg === null) {
      logMsg(prefix + "null");
    } else if (typeof arg == "string") {
      logMsg(prefix + arg);
    } else if (typeof arg == "number") {
      logMsg(prefix + arg);
    } else if (typeof arg == "boolean") {
      logMsg(prefix + (arg ? "true" : "false"));
    } else if (Array.isArray(arg)) {
      logMsg(prefix + "[" + arg.map((value) => toHex(value)).join(", ") + "]");
    } else if (typeof arg == "object" && arg instanceof Uint8Array) {
      logMsg(
        prefix +
          "[" +
          Array.from(arg)
            .map((value) => toHex(value))
            .join(", ") +
          "]",
      );
    } else {
      logMsg(prefix + "Unhandled type of argument:" + typeof arg);
      console.log(arg);
    }
    prefix = ""; // Only show for first argument
  }
}

function errorMsg(text) {
  logMsg('<span class="error-message">Error:</span> ' + text);
  console.error(text);
}

/**
 * @name updateTheme
 * Sets the theme to dark mode. Can be refactored later for more themes
 */
function updateTheme() {
  // Disable all themes
  document
    .querySelectorAll("link[rel=stylesheet].alternate")
    .forEach((styleSheet) => {
      enableStyleSheet(styleSheet, false);
    });

  if (darkMode.checked) {
    enableStyleSheet(darkSS, true);
  } else {
    enableStyleSheet(lightSS, true);
  }
}

function enableStyleSheet(node, enabled) {
  node.disabled = !enabled;
}

/**
 * Parse flash size string (e.g., "256KB", "4MB") to bytes
 * @param {string} sizeStr - Flash size string with unit (KB or MB)
 * @returns {number} Size in bytes
 */
function parseFlashSize(sizeStr) {
  if (!sizeStr || typeof sizeStr !== 'string') {
    return 0;
  }
  
  // Extract number and unit
  const match = sizeStr.match(/^(\d+)(KB|MB)$/i);
  if (!match) {
    // If no unit, assume it's already in MB (legacy behavior)
    const num = parseInt(sizeStr);
    return isNaN(num) ? 0 : num * 1024 * 1024;
  }
  
  const value = parseInt(match[1]);
  const unit = match[2].toUpperCase();
  
  if (unit === 'KB') {
    return value * 1024; // KB to bytes
  } else if (unit === 'MB') {
    return value * 1024 * 1024; // MB to bytes
  }
  
  return 0;
}

/**
 * @name clickConnect
 * Click handler for the connect/disconnect button.
 */
async function clickConnect() {
  console.log('[clickConnect] Function called');
  
  if (espStub) {
    console.log('[clickConnect] Already connected, disconnecting...');
    // Remove disconnect event listener to prevent it from firing during manual disconnect
    if (espStub.handleDisconnect) {
      espStub.removeEventListener("disconnect", espStub.handleDisconnect);
    }
    
    await espStub.disconnect();
    try {
      await espStub.port?.close?.();
    } catch (e) {
      // ignore double-close
    }
    toggleUIConnected(false);
    espStub = undefined;
    
    // Clear all cached data and state
    clearAllCachedData();
    
    return;
  }

  console.log('[clickConnect] Getting esploaderMod...');
  const esploaderMod = await window.esptoolPackage;

  // Platform detection: Android always uses WebUSB, Desktop uses Web Serial
  const userAgent = navigator.userAgent || '';
  const isAndroid = /Android/i.test(userAgent);
  
  // Only log platform details to UI in debug mode (avoid fingerprinting surface)
  if (debugMode.checked) {
    const platformMsg = `Platform: ${isAndroid ? 'Android' : 'Desktop'} (UA: ${userAgent.substring(0, 50)}...)`;
    logMsg(platformMsg);
  }
  logMsg(`Using: ${isAndroid ? 'WebUSB' : 'Web Serial'}`);
  
  let esploader;
  
  if (isAndroid) {
    // Android: Use WebUSB directly
    console.log('[Connect] Using WebUSB for Android');
    try {
      const port = await WebUSBSerial.requestPort((...args) => logMsg(...args));
      esploader = await esploaderMod.connectWithPort(port, {
        log: (...args) => logMsg(...args),
        debug: (...args) => debugMsg(...args),
        error: (...args) => errorMsg(...args),
      });
    } catch (err) {
      logMsg(`WebUSB connection failed: ${err.message || err}`);
      throw err;
    }
  } else {
    // Desktop: Use Web Serial (standard esptool connect)
    console.log('[Connect] Using Web Serial for Desktop');
    esploader = await esploaderMod.connect({
      log: (...args) => logMsg(...args),
      debug: (...args) => debugMsg(...args),
      error: (...args) => errorMsg(...args),
    });
  }
  
  // Handle ESP32-S2 Native USB reconnection requirement for BROWSER
  // Only add listener if not already in reconnect mode
  if (!esp32s2ReconnectInProgress) {
    esploader.addEventListener("esp32s2-usb-reconnect", async () => {
      // Prevent recursive calls
      if (esp32s2ReconnectInProgress) {
        return;
      }
      
      esp32s2ReconnectInProgress = true;
      logMsg("ESP32-S2 Native USB detected!");
      toggleUIConnected(false);
      const previousStubPort = espStub?.port;
      espStub = undefined;
      
      try {
        // Close the port first
        await esploader.port.close();

        // Use the modal dialog approach
        if (previousStubPort && previousStubPort.readable) {
          await previousStubPort.close();
        }
      } catch (closeErr) {
        // Ignore port close errors
        debugMsg(`Port close error (ignored): ${closeErr.message}`);
      }
      
      // Show modal dialog
      const modal = document.getElementById("esp32s2Modal");
      const reconnectBtn = document.getElementById("butReconnectS2");
        
      modal.classList.remove("hidden");
        
      // Handle reconnect button click
      const handleReconnect = async () => {
        modal.classList.add("hidden");
        reconnectBtn.removeEventListener("click", handleReconnect);
          
        logMsg("Requesting new device selection...");
          
        // Trigger port selection
        try {
          await clickConnect();
          // Reset flag on successful connection
          esp32s2ReconnectInProgress = false;
        } catch (err) {
          errorMsg("Failed to reconnect: " + err);
          // Reset flag on error so user can try again
          esp32s2ReconnectInProgress = false;
        }
      };
      reconnectBtn.addEventListener("click", handleReconnect);
    });
  }
  
  try {
    await esploader.initialize();
  } catch (err) {
    // If ESP32-S2 reconnect is in progress (handled by event listener), suppress the error
    if (esp32s2ReconnectInProgress) {
      logMsg("Initialization interrupted for ESP32-S2 reconnection.");
      return;
    }
    
    // Not ESP32-S2 or other error
    try {
      await esploader.disconnect();
    } catch (disconnectErr) {
      // Ignore disconnect errors
    }
    throw err;
  }

  // logMsg("Connected to " + esploader.chipName);
  logMsg("MAC Address: " + formatMacAddr(esploader.macAddr()));

  // Store chip info globally
  currentChipName = esploader.chipName;
  currentMacAddr = formatMacAddr(esploader.macAddr());

  espStub = await esploader.runStub();
  
  // Update advanced parameters based on actual connection type (WebUSB vs Web Serial)
  // Only update if user hasn't manually changed them (still at defaults)
  updateAdvancedParamsForConnection();
  
  toggleUIConnected(true);
  toggleUIToolbar(true);
  
  // Auto-initialize console if it was enabled before
  if (consoleSwitch.checked) {
    logMsg("Auto-initializing console from saved settings...");
    await clickConsole();
  }
  
  // Check if ESP8266 and show filesystem button
  const isESP8266 = currentChipName && currentChipName.toUpperCase().includes("ESP8266");
  if (isESP8266) {
    // Hide partition table button for ESP8266
    butReadPartitions.classList.add('hidden');
    
    // Show ESP8266 filesystem detection button
    butDetectFS.classList.remove('hidden');
  } else {
    // Show partition table button for ESP32
    butReadPartitions.classList.remove('hidden');
    
    // Hide ESP8266 filesystem detection button
    if (butDetectFS) {
      butDetectFS.classList.add('hidden');
    }
  }
  
  // Set detected flash size in the read size field
  if (espStub.flashSize) {
    const flashSizeBytes = parseFlashSize(espStub.flashSize);
    readSize.value = "0x" + flashSizeBytes.toString(16);
  }
  
  // Set the selected baud rate
  let baud = parseInt(baudRateSelect.value);
  if (baudRates.includes(baud) && esploader.chipName !== "ESP8266") {
    await espStub.setBaudrate(baud);
  }
  
  // Store disconnect handler so we can remove it later
  const handleDisconnect = () => {
    toggleUIConnected(false);
    espStub = false;
  };
  espStub.handleDisconnect = handleDisconnect; // Store reference on espStub
  espStub.addEventListener("disconnect", handleDisconnect);
}

/**
 * @name changeBaudRate
 * Change handler for the Baud Rate selector.
 */
async function changeBaudRate() {
  saveSetting("baudrate", baudRateSelect.value);
  if (espStub) {
    let baud = parseInt(baudRateSelect.value);
    if (baudRates.includes(baud)) {
      await espStub.setBaudrate(baud);
    }
  }
}

/**
 * @name clickAutoscroll
 * Change handler for the Autoscroll checkbox.
 */
async function clickAutoscroll() {
  saveSetting("autoscroll", autoscroll.checked);
}

/**
 * @name clickDarkMode
 * Change handler for the Dark Mode checkbox.
 */
async function clickDarkMode() {
  updateTheme();
  saveSetting("darkmode", darkMode.checked);
}

/**
 * @name clickDebugMode
 * Change handler for the Debug Mode checkbox.
 */
async function clickDebugMode() {
  saveSetting("debugmode", debugMode.checked);
  logMsg("Debug mode " + (debugMode.checked ? "enabled" : "disabled"));
}

/**
 * @name clickShowLog
 * Change handler for the Show Log checkbox.
 */
async function clickShowLog() {
  saveSetting("showlog", showLog.checked);
  updateLogVisibility();
}

/**
 * @name openConsolePortAndInit
 * Helper to open port for console and initialize console UI
 * Avoids code duplication across different console init flows
 */
async function openConsolePortAndInit(newPort) {
  // Open the port at 115200 for console
  await newPort.open({ baudRate: 115200 });
  espStub.port = newPort;
  espStub.connected = true;
  
  // Keep parent/loader in sync (used by closeConsole)
  if (espStub._parent) {
    espStub._parent.port = newPort;
  }
  if (espLoaderBeforeConsole) {
    espLoaderBeforeConsole.port = newPort;
  }
  
  debugMsg("Port opened for console at 115200 baud");
  
  // Device is already in firmware mode, port is open at 115200
  // Initialize console directly
  consoleSwitch.checked = true;
  saveSetting("console", true);
  
  // Initialize console UI and handlers
  await initConsoleUI();
}

/**
 * @name initConsoleUI
 * Initialize console UI, event handlers, and start console instance
 * Extracted helper to avoid duplication across different console init flows
 */
async function initConsoleUI() {
  // Wait for port to be ready
  await sleep(200);
  
  // Show console container and hide commands
  consoleContainer.classList.remove("hidden");
  
  // Add console-active class to body for mobile styling
  document.body.classList.add("console-active");
  const commands = document.getElementById("commands");
  if (commands) commands.classList.add("hidden");
  
  // Initialize console
  consoleInstance = new ESP32ToolConsole(espStub.port, consoleContainer, true);
  await consoleInstance.init();
  
  // Check if console reset is supported and hide button if not
  if (espLoaderBeforeConsole && typeof espLoaderBeforeConsole.isConsoleResetSupported === 'function') {
    const resetSupported = espLoaderBeforeConsole.isConsoleResetSupported();
    const resetBtn = consoleContainer.querySelector("#console-reset-btn");
    if (resetBtn) {
      if (resetSupported) {
        resetBtn.style.display = "";
      } else {
        resetBtn.style.display = "none";
        debugMsg("Console reset disabled for ESP32-S2 USB-JTAG/CDC (hardware limitation)");
      }
    }
  }
  
  // Listen for console reset events
  if (consoleResetHandler) {
    consoleContainer.removeEventListener('console-reset', consoleResetHandler);
  }
  consoleResetHandler = async () => {
    if (espLoaderBeforeConsole && typeof espLoaderBeforeConsole.resetInConsoleMode === 'function') {
      try {
        debugMsg("Resetting device from console...");
        await espLoaderBeforeConsole.resetInConsoleMode();
        debugMsg("Device reset successful");
      } catch (err) {
        errorMsg("Failed to reset device: " + err.message);
      }
    }
  };
  consoleContainer.addEventListener('console-reset', consoleResetHandler);
  
  // Listen for console close events
  if (consoleCloseHandler) {
    consoleContainer.removeEventListener('console-close', consoleCloseHandler);
  }
  consoleCloseHandler = async () => {
    if (!consoleSwitch.checked) return;
    logMsg("Closing console");
    consoleSwitch.checked = false;
    saveSetting("console", false);
    await closeConsole();
  };
  consoleContainer.addEventListener('console-close', consoleCloseHandler);
  
  // Listen for console bootloader detection events
  // The console detects bootloader patterns in real-time as data arrives
  // and dispatches this event when bootloader is detected
  if (consoleBootloaderHandlerModule) {
    consoleContainer.removeEventListener('console-bootloader', consoleBootloaderHandlerModule);
  }
  consoleBootloaderHandlerModule = async () => {
    logMsg(`⚠️ Console detected bootloader mode - resetting to firmware...`);
    if (espLoaderBeforeConsole && typeof espLoaderBeforeConsole.resetInConsoleMode === 'function'
        && espLoaderBeforeConsole.isConsoleResetSupported()) {
      try {
        await espLoaderBeforeConsole.resetInConsoleMode();
        logMsg("✅ Device reset to firmware mode");
        // Clear console to see new output after reset
        if (consoleInstance && typeof consoleInstance.clear === 'function') {
          consoleInstance.clear();
        }
      } catch (err) {
        errorMsg("❌ Failed to reset device: " + err.message);
      }
    }
  };
  consoleContainer.addEventListener('console-bootloader', consoleBootloaderHandlerModule);
  
  logMsg("Console initialized");
}

/**
 * @name clickConsole
 * Change handler for the Console checkbox.
 */
async function clickConsole() {
  const shouldEnable = consoleSwitch.checked;
  
  if (shouldEnable) {
    // After WDT reset, everything is gone - start fresh with port selection
    // Initialize console if connected and not already created
    if (isConnected && espStub && espStub.port && !consoleInstance) {
      try {
        // CRITICAL: Save current state BEFORE changing anything
        // If espStub has a parent, we need to get the baudrate from the parent!
        // The stub child can not be used for restoring the stub. the parent must be used!
        const loaderToSave = espStub._parent || espStub;
        const currentBaudrate = loaderToSave.currentBaudRate;
        const currentChipFamily = espStub.chipFamily;

        // CRITICAL: Save the PARENT loader (not the stub child!)
        espLoaderBeforeConsole = loaderToSave;
        baudRateBeforeConsole = currentBaudrate;
        chipFamilyBeforeConsole = currentChipFamily;

        // Console ALWAYS runs at 115200 baud (firmware default)
        // Always set baudrate to 115200 before opening console
        try {
          await espStub.setBaudrate(115200);
          debugMsg("Baudrate set to 115200 for console");
        } catch (baudErr) {
          logMsg(`Failed to set baudrate to 115200: ${baudErr.message}`);
        }
        
        // Enter console mode - handles both USB-JTAG and serial chip devices
        try {
          const portWasClosed = await espStub.enterConsoleMode();
          
          if (portWasClosed) {
            // USB-JTAG/OTG device: Port was closed after WDT reset
            debugMsg("Device reset to firmware mode (port closed)");
            
            // Wait for device to boot and USB port to become available
            // Android/WebUSB needs more time than Desktop for USB enumeration
            const isWebUSB = isUsingWebUSB();
            const waitTime = isWebUSB ? 1000 : 500; // 1s for Android, 500ms for Desktop
            debugMsg(`Waiting ${waitTime}ms for device to boot and USB to enumerate...`);
            await sleep(waitTime);
            
            // Check if this is ESP32-S2 or if we're on Android (WebUSB)
            // Both need modal for user gesture
            const isS2 = chipFamilyBeforeConsole === 0x3252; // CHIP_FAMILY_ESP32S2 = 0x3252
            const needsModal = isS2 || isWebUSB;
            
            if (needsModal) {
              // ESP32-S2 (all platforms) or Android (all chips): Use modal for user gesture
              
              // After WDT reset, the USB device re-enumerates and creates a NEW port
              // The old port is dead and will be garbage collected by the browser
              // We just need to clear our references to it
              espStub.port = null;
              espStub.connected = false;
              espStub._writer = undefined;
              espStub._reader = undefined;
              
              if (espStub._parent) {
                espStub._parent.port = null;
                espStub._parent.connected = false;
              }
              if (espLoaderBeforeConsole) {
                espLoaderBeforeConsole.port = null;
                espLoaderBeforeConsole.connected = false;
              }
              
              debugMsg("Old port references cleared (USB device will re-enumerate)");
              
              // Wait for browser to process port closure and USB re-enumeration
              await sleep(300);
              
              // Show modal for port selection (requires user gesture)
              const modal = document.getElementById("esp32s2Modal");
              const reconnectBtn = document.getElementById("butReconnectS2");
              
              // Update modal text for console mode
              const modalTitle = modal.querySelector("h2");
              const modalText = modal.querySelector("p");
              if (modalTitle) modalTitle.textContent = "Device has been reset to firmware mode";
              if (modalText) {
                modalText.textContent = isWebUSB 
                  ? "Please click the button below to select the USB device for console."
                  : "Please click the button below to select the serial port for console.";
              }
              
              modal.classList.remove("hidden");
              
              // Handle reconnect button click (single-fire to prevent multiple prompts)
              const handleReconnect = async () => {
                modal.classList.add("hidden");
                
                try {
                  // Request the NEW port (user gesture from button click)
                  debugMsg("Please select the port for console mode...");
                  const newPort = isWebUSB
                    ? await WebUSBSerial.requestPort((...args) => logMsg(...args))
                    : await navigator.serial.requestPort();
                  
                  // Use helper to open port and initialize console
                  await openConsolePortAndInit(newPort);
                } catch (err) {
                  errorMsg(`Failed to open port for console: ${err.message}`);
                  consoleSwitch.checked = false;
                  saveSetting("console", false);
                }
              };
              
              // Use { once: true } to ensure single-fire and automatic cleanup
              reconnectBtn.addEventListener("click", handleReconnect, { once: true });
            } else {
              // Desktop (Web Serial) with ESP32-S3/C3/C5/C6/H2/P4: Direct requestPort
              try {
                // Request port selection from user (direct)
                debugMsg("Please select the serial port again for console mode...");
                const newPort = await navigator.serial.requestPort();
                
                // Use helper to open port and initialize console
                await openConsolePortAndInit(newPort);
              } catch (err) {
                errorMsg(`Failed to open port for console: ${err.message}`);
                consoleSwitch.checked = false;
                saveSetting("console", false);
              }
            }
            
            return;
          } else {
            // Serial chip device: Port stays open
            debugMsg("Device reset to firmware mode");
          }
        } catch (err) {
          errorMsg(`Failed to enter console mode: ${err.message}`);
          consoleSwitch.checked = false;
          saveSetting("console", false);
          return;
        }
        
        // Wait for:
        // - Firmware to start after reset
        // - Port to be ready for new reader
        await sleep(500);
        
        // Initialize console UI and handlers
        await initConsoleUI();
        
        saveSetting("console", true);
      } catch (err) {
        errorMsg("Failed to initialize console: " + err.message);
        consoleSwitch.checked = false;
        saveSetting("console", false);
        await closeConsole();
      }
    } else if (!isConnected) {
      // Not connected - just show message
      consoleSwitch.checked = false;
      saveSetting("console", false);
      errorMsg("Please connect to device first");
    }
  } else {
    await closeConsole();
    saveSetting("console", false);
  }
}

/**
 * @name closeConsole
 * Close console and restore device to bootloader state
 */
async function closeConsole() {
  // Remove console-active class from body FIRST to restore visibility
  document.body.classList.remove("console-active");
  
  // Hide console and show commands again
  consoleContainer.classList.add("hidden");
  const commands = document.getElementById("commands");
  if (commands) {
    commands.classList.remove("hidden");
    // Force display to ensure it's visible
    commands.style.display = "";
  }
  
  // Restore original state (bootloader + stub + baudrate)
  if (espLoaderBeforeConsole && Number.isFinite(baudRateBeforeConsole)) {
    // Disconnect console first to release locks
    if (consoleInstance) {
      try {
        await consoleInstance.disconnect();
      } catch (err) {
        debugMsg("Error disconnecting console: " + err);
      }
      consoleInstance = null;
    }
    
    // Remove console event handlers
    if (consoleResetHandler) {
      consoleContainer.removeEventListener('console-reset', consoleResetHandler);
      consoleResetHandler = null;
    }
    if (consoleCloseHandler) {
      consoleContainer.removeEventListener('console-close', consoleCloseHandler);
      consoleCloseHandler = null;
    }
    if (consoleBootloaderHandlerModule) {
      consoleContainer.removeEventListener('console-bootloader', consoleBootloaderHandlerModule);
      consoleBootloaderHandlerModule = null;
    }
    
    // Use esp_loader's exitConsoleMode function
    try {
      const needsManualReconnect = await espLoaderBeforeConsole.exitConsoleMode();
      
      if (needsManualReconnect) {
        // Port has changed, need to select new port
        // logMsg("Port changed - please select the new port");
        toggleUIConnected(false);
        espStub = undefined;
        
        // Wait a moment for port to stabilize
        await sleep(1000);
        
        // Trigger port selection
        try {
          await clickConnect();
          espLoaderBeforeConsole = null;
          baudRateBeforeConsole = null;
          chipFamilyBeforeConsole = null;
        } catch (err) {
          errorMsg("Failed to reconnect: " + err);
        }
      } else {
        // Other devices: reconnectToBootloader was called successfully
        // Reload stub
        const newStub = await espLoaderBeforeConsole.runStub();
        espStub = newStub;

        // Restore baudrate
        if (baudRateBeforeConsole !== 115200) {
          await espStub.setBaudrate(baudRateBeforeConsole);
        }

        espLoaderBeforeConsole = null;
        baudRateBeforeConsole = null;
        chipFamilyBeforeConsole = null;
      }
    } catch (err) {
      errorMsg("Failed to exit console mode: " + err.message);
      espStub = undefined;
      toggleUIConnected(false);
      espLoaderBeforeConsole = null;
      baudRateBeforeConsole = null;
      chipFamilyBeforeConsole = null;
    }
  }
}

/**
 * @name updateLogVisibility
 * Update log and log controls visibility
 */
function updateLogVisibility() {
  const logControls = document.querySelector(".log-controls");
  
  if (showLog.checked) {
    log.classList.remove("hidden");
    if (logControls) {
      logControls.classList.remove("hidden");
    }
  } else {
    log.classList.add("hidden");
    if (logControls) {
      logControls.classList.add("hidden");
    }
  }
}

/**
 * @name clickAdvancedMode
 * Change handler for the Advanced Mode checkbox.
 */
async function clickAdvancedMode() {
  saveSetting("advanced", advancedMode.checked);
  updateAdvancedVisibility();
}

/**
 * @name changeAdvancedParam
 * Change handler for advanced parameter dropdowns.
 */
async function changeAdvancedParam() {
  saveSetting("chunkSize", parseInt(chunkSizeSelect.value));
  saveSetting("blockSize", parseInt(blockSizeSelect.value));
  saveSetting("maxInFlight", parseInt(maxInFlightSelect.value));
}

/**
 * @name updateAdvancedVisibility
 * Update advanced controls visibility
 */
function updateAdvancedVisibility() {
  if (advancedMode.checked) {
    advancedRow.style.display = "flex";
    main.classList.add("advanced-active");
  } else {
    advancedRow.style.display = "none";
    main.classList.remove("advanced-active");
  }
  // Update main padding based on header height
  updateMainPadding();
}

/**
 * @name updateMainPadding
 * Dynamically adjust main content padding based on header height
 */
function updateMainPadding() {
  // Use requestAnimationFrame to ensure DOM has updated
  requestAnimationFrame(() => {
    const header = document.querySelector('.header');
    const main = document.querySelector('.main');
    
    // Guard against missing elements
    if (!header || !main) {
      return;
    }
    
    const headerHeight = header.offsetHeight;
    // Add small buffer (10px) for better spacing
    main.style.paddingTop = (headerHeight + 10) + 'px';
  });
}

/**
 * @name clickDetectFS
 * Detect ESP8266 filesystem and open manager directly
 */
async function clickDetectFS() {
  if (!espStub || !espStub.flashSize) {
    errorMsg('Not connected or flash size unknown');
    return;
  }
  
  try {
    butDetectFS.disabled = true;
    logMsg('Detecting ESP8266 filesystem...');
    
    const flashSizeBytes = parseFlashSize(espStub.flashSize);
    const flashSizeMB = flashSizeBytes / (1024 * 1024);
    const esptoolMod = await window.esptoolPackage;
    
    // Scan flash for filesystem signatures - optimized based on flash size
    let scanOffsets = [];
    
    if (flashSizeMB >= 4) {
      // 4MB/8MB/16MB Flash
      scanOffsets = [
        { offset: 0x200000, size: 0x10000 }, // Most common: 2MB/6MB/14MB FS
        { offset: 0x100000, size: 0x10000 }, // Alternative: 3MB/7MB/15MB FS
        { offset: 0x300000, size: 0x10000 }, // 4MB only: 1MB FS
      ];
    } else if (flashSizeMB >= 2) {
      // 2MB Flash
      scanOffsets = [
        { offset: 0x100000, size: 0x10000 }, // 1MB FS
        { offset: 0x180000, size: 0x10000 }, // 512KB FS
        { offset: 0x1c0000, size: 0x10000 }, // 256KB FS
        { offset: 0x1e0000, size: 0x1b000 }, // 128KB + 64KB FS (covers 0x1e0000 and 0x1f0000)
      ];
    } else if (flashSizeMB >= 1) {
      // 1MB Flash - one large read covers all 7 possible offsets
      scanOffsets = [
        { offset: 0x07b000, size: 0x80000 }, // Covers all: 512KB, 256KB, 192KB, 160KB, 144KB, 128KB, 64KB
      ];
    } else if (flashSizeMB >= 0.5) {
      // 512KB Flash
      scanOffsets = [
        { offset: 0x05b000, size: 0x20000 }, // Covers 128KB, 64KB, 32KB (0x05b000, 0x06b000, 0x073000)
      ];
    }
    
    // Collect all found filesystems
    const foundFilesystems = [];
    
    for (const scan of scanOffsets) {
      if (scan.offset + scan.size > flashSizeBytes) {
        continue;
      }
      
      try {
        logMsg(`Scanning at 0x${scan.offset.toString(16)}...`);
        const scanData = await espStub.readFlash(scan.offset, scan.size);
        
        // Check multiple offsets within the read data
        const checkOffsets = [];
        if (scan.size > 0x10000) {
          // Large read - check multiple positions
          for (let pos = 0; pos < scan.size; pos += 0x10000) {
            checkOffsets.push(scan.offset + pos);
          }
        } else {
          // Small read - check only start position
          checkOffsets.push(scan.offset);
        }
        
        for (const checkOffset of checkOffsets) {
          const dataOffset = checkOffset - scan.offset;
          if (dataOffset + 0x10000 > scanData.length) continue;
          
          const checkData = scanData.slice(dataOffset, dataOffset + 0x10000);
          const scannedLayout = esptoolMod.scanESP8266Filesystem(checkData, checkOffset, flashSizeBytes);
          
          if (scannedLayout) {
            const fsType = esptoolMod.detectFilesystemFromImage(checkData, currentChipName);
            
            // Validate: Check if it's a real filesystem with valid magic
            if (fsType !== 'unknown') {
              foundFilesystems.push({
                layout: scannedLayout,
                fsType: fsType,
                data: checkData
              });
              logMsg(`Found ${fsType.toUpperCase()} at 0x${scannedLayout.start.toString(16)} - 0x${scannedLayout.end.toString(16)} (${formatSize(scannedLayout.size)})`);
            }
          }
        }
        
      } catch (e) {
        // Continue scanning
        logMsg(`Scan at 0x${scan.offset.toString(16)} failed: ${e.message || e}`);
      }
    }
    
    // Choose the best filesystem from found ones
    let detectedLayout = null;
    
    if (foundFilesystems.length === 0) {
      // No filesystem found - use fallback
      logMsg('No filesystem found by scanning, using default layout...');
      const fsLayouts = esptoolMod.getESP8266FilesystemLayout(flashSizeMB);
      if (fsLayouts && fsLayouts.length > 0) {
        detectedLayout = fsLayouts[0];
        logMsg(`Using default layout for ${flashSizeMB}MB flash: 0x${detectedLayout.start.toString(16)} - 0x${detectedLayout.end.toString(16)} (${formatSize(detectedLayout.size)})`);
      }
    } else if (foundFilesystems.length === 1) {
      // Only one found - use it
      detectedLayout = foundFilesystems[0].layout;
      logMsg(`Using detected filesystem at 0x${detectedLayout.start.toString(16)}`);
    } else {
      // Multiple found - choose the best one
      // Prefer filesystems with valid size from block_count over layout-based sizes
      logMsg(`Found ${foundFilesystems.length} filesystems, selecting best match...`);
      
      // Sort by: 1) Has valid block_count (size not from layout), 2) Smallest offset
      foundFilesystems.sort((a, b) => {
        // Check if size matches a known layout (indicates fallback was used)
        const aIsLayout = [0x1fa000, 0x2fa000, 0x0fa000, 0x5fa000, 0x6fa000, 0xdfa000, 0xefa000].includes(a.layout.size);
        const bIsLayout = [0x1fa000, 0x2fa000, 0x0fa000, 0x5fa000, 0x6fa000, 0xdfa000, 0xefa000].includes(b.layout.size);
        
        if (aIsLayout !== bIsLayout) {
          return aIsLayout ? 1 : -1; // Prefer non-layout (real block_count)
        }
        
        return a.layout.start - b.layout.start; // Then prefer smaller offset
      });
      
      detectedLayout = foundFilesystems[0].layout;
      logMsg(`Selected filesystem at 0x${detectedLayout.start.toString(16)} (${formatSize(detectedLayout.size)})`);
    }
    
    if (!detectedLayout) {
      errorMsg('No filesystem layout found for this flash size');
      butDetectFS.disabled = false;
      return;
    }
    
    // Show progress bar
    readProgress.classList.remove('hidden');
    const progressBar = readProgress.querySelector('div');
    if (progressBar) {
      progressBar.style.width = '0%';
    }
    
    // Read the filesystem with real progress tracking
    logMsg(`Reading ${formatSize(detectedLayout.size)} from 0x${detectedLayout.start.toString(16)}...`);
    
    const fsData = await espStub.readFlash(
      detectedLayout.start, 
      detectedLayout.size,
      (packet, progress, totalSize) => {
        // Update progress bar with real progress
        if (progressBar) {
          const percentage = (progress / totalSize) * 100;
          progressBar.style.width = `${percentage.toFixed(1)}%`;
        }
      }
    );
    
    // Keep progress bar at 100% for a moment
    if (progressBar) {
      progressBar.style.width = '100%';
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    readProgress.classList.add('hidden');
    
    // Store the data for later use
    lastReadFlashData = fsData;

    // Hide Open FS Manager since we're opening directly
    butOpenFSManager.classList.add('hidden');

    // Detect filesystem type
    const fsType = esptoolMod.detectFilesystemFromImage(fsData, currentChipName);
    logMsg(`Detected filesystem type: ${fsType.toUpperCase()}`);
    
    if (fsType === 'unknown') {
      errorMsg('Could not detect filesystem type');
      butDetectFS.disabled = false;
      return;
    }
    
    // Create a partition object for compatibility
    const partition = {
      name: 'filesystem',
      type: 0x01,
      subtype: fsType === 'littlefs' ? 0x82 : (fsType === 'fatfs' ? 0x81 : 0x82),
      offset: detectedLayout.start,
      size: detectedLayout.size,
      _readData: fsData,
      _blockSize: detectedLayout.block,
      _pageSize: detectedLayout.page
    };
    
    // Open the filesystem directly
    if (fsType === 'littlefs') {
      await openLittleFS(partition);
    } else if (fsType === 'fatfs') {
      await openFatFS(partition);
    } else if (fsType === 'spiffs') {
      await openSPIFFS(partition);
    }
    
  } catch (e) {
    errorMsg(`Failed to detect/open filesystem: ${e.message || e}`);
    debugMsg('Filesystem detection error details: ' + e);
  } finally {
    // Hide progress bar
    readProgress.classList.add('hidden');
    butDetectFS.disabled = false;
  }
}

/**
 * @name clickErase
 * Click handler for the erase button.
 */
async function clickErase() {
  let confirmed = false;
  
  if (isElectron) {
    confirmed = await window.electronAPI.showConfirm("This will erase the entire flash. Click OK to continue.");
  } else {
    confirmed = window.confirm("This will erase the entire flash. Click OK to continue.");
  }
  
  if (confirmed) {
    baudRateSelect.disabled = true;
    butErase.disabled = true;
    butProgram.disabled = true;
    try {
      logMsg("Erasing flash memory. Please wait...");
      let stamp = Date.now();
      await espStub.eraseFlash();
      logMsg("Finished. Took " + (Date.now() - stamp) + "ms to erase.");
    } catch (e) {
      errorMsg(e);
    } finally {
      butErase.disabled = false;
      baudRateSelect.disabled = false;
      butProgram.disabled = getValidFiles().length == 0;
    }
  }
}

/**
 * @name clickProgram
 * Click handler for the program button.
 */
async function clickProgram() {
  const readUploadedFileAsArrayBuffer = (inputFile) => {
    const reader = new FileReader();

    return new Promise((resolve, reject) => {
      reader.onerror = () => {
        reader.abort();
        reject(new DOMException("Problem parsing input file."));
      };

      reader.onload = () => {
        resolve(reader.result);
      };
      reader.readAsArrayBuffer(inputFile);
    });
  };

  baudRateSelect.disabled = true;
  butErase.disabled = true;
  butProgram.disabled = true;
  for (let i = 0; i < firmware.length; i++) {
    firmware[i].disabled = true;
    offsets[i].disabled = true;
  }
  for (let file of getValidFiles()) {
    progress[file].classList.remove("hidden");
    let binfile = firmware[file].files[0];
    let contents = await readUploadedFileAsArrayBuffer(binfile);
    try {
      let offset = parseInt(offsets[file].value, 16);
      const progressBar = progress[file].querySelector("div");
      await espStub.flashData(
        contents,
        (bytesWritten, totalBytes) => {
          progressBar.style.width =
            Math.floor((bytesWritten / totalBytes) * 100) + "%";
        },
        offset,
      );
      await sleep(100);
    } catch (e) {
      errorMsg(e);
    }
  }
  for (let i = 0; i < firmware.length; i++) {
    firmware[i].disabled = false;
    offsets[i].disabled = false;
    progress[i].classList.add("hidden");
    progress[i].querySelector("div").style.width = "0";
  }
  butErase.disabled = false;
  baudRateSelect.disabled = false;
  butProgram.disabled = getValidFiles().length == 0;
  logMsg("To run the new firmware, please reset your device.");
}

function getValidFiles() {
  // Get a list of file and offsets
  // This will be used to check if we have valid stuff
  // and will also return a list of files to program
  let validFiles = [];
  let offsetVals = [];
  for (let i = 0; i < firmware.length; i++) {
    let offs = parseInt(offsets[i].value, 16);
    if (firmware[i].files.length > 0 && !offsetVals.includes(offs)) {
      validFiles.push(i);
      offsetVals.push(offs);
    }
  }
  return validFiles;
}

/**
 * @name checkProgrammable
 * Check if the conditions to program the device are sufficient
 */
async function checkProgrammable() {
  butProgram.disabled = getValidFiles().length == 0;
}

/**
 * @name checkFirmware
 * Handler for firmware upload changes
 */
async function checkFirmware(event) {
  let filename = event.target.value.split("\\").pop();
  let label = event.target.parentNode.querySelector("span");
  let icon = event.target.parentNode.querySelector("svg");
  if (filename != "") {
    label.innerHTML = filename;
    icon.classList.add("hidden");
  } else {
    label.innerHTML = "Choose a file&hellip;";
    icon.classList.remove("hidden");
  }

  await checkProgrammable();
  updateUploadRowsVisibility();
}

/**
 * @name updateUploadRowsVisibility
 * Show/hide upload rows dynamically - only for flash write section
 */
function updateUploadRowsVisibility() {
  const uploadRows = document.querySelectorAll(".upload");
  let lastFilledIndex = -1;
  
  // Find the last filled row
  for (let i = 0; i < firmware.length; i++) {
    if (firmware[i].files.length > 0) {
      lastFilledIndex = i;
    }
  }
  
  // Show rows up to lastFilledIndex + 1 (next empty row), minimum 1 row
  for (let i = 0; i < uploadRows.length; i++) {
    if (i <= lastFilledIndex + 1) {
      uploadRows[i].style.display = "flex";
    } else {
      uploadRows[i].style.display = "none";
    }
  }
}

/**
 * @name clickReadFlash
 * Click handler for the read flash button.
 */
async function clickReadFlash() {
  const offset = parseInt(readOffset.value, 16);
  const size = parseInt(readSize.value, 16);

  if (isNaN(offset) || isNaN(size) || size <= 0) {
    errorMsg("Invalid offset or size value");
    return;
  }

  // Create filename with chip type and MAC address
  const chipInfo = currentChipName ? currentChipName.replace(/\s+/g, '_') : 'ESP';
  const macInfo = currentMacAddr ? currentMacAddr.replace(/:/g, '') : '';
  const defaultFilename = `${chipInfo}${macInfo ? '_' + macInfo : ''}_flash_0x${offset.toString(16)}_0x${size.toString(16)}.bin`;

  baudRateSelect.disabled = true;
  butErase.disabled = true;
  butProgram.disabled = true;
  butReadFlash.disabled = true;
  readOffset.disabled = true;
  readSize.disabled = true;
  readProgress.classList.remove("hidden");

  try {
    const progressBar = readProgress.querySelector("div");

    // Prepare options object if advanced mode is enabled
    // Option validation helpers
    const validateOption = (name, value) => {
      if (value === undefined) return undefined;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid ${name}: ${value}`);
      }
      return value;
    };

    let options = undefined;
    let chunkSizeOpt, blockSizeOpt, maxInFlightOpt;
    if (advancedMode.checked) {
      chunkSizeOpt = validateOption("chunkSize", parseInt(chunkSizeSelect.value));
      blockSizeOpt = validateOption("blockSize", parseInt(blockSizeSelect.value));
      maxInFlightOpt = validateOption("maxInFlight", parseInt(maxInFlightSelect.value));
      if ((blockSizeOpt ?? maxInFlightOpt) &&
          (blockSizeOpt === undefined || maxInFlightOpt === undefined)) {
        throw new Error("blockSize and maxInFlight must be provided together");
      }
      options = {
        chunkSize: chunkSizeOpt,
        blockSize: blockSizeOpt,
        maxInFlight: maxInFlightOpt
      };
      logMsg(`Advanced mode: chunkSize=0x${options.chunkSize?.toString(16)}, blockSize=${options.blockSize}, maxInFlight=${options.maxInFlight}`);
    }

    const data = await espStub.readFlash(
      offset,
      size,
      (packet, progress, totalSize) => {
        progressBar.style.width =
          Math.floor((progress / totalSize) * 100) + "%";
      },
      options
    );

    logMsg(`Successfully read ${data.length} bytes from flash`);

    // Save file using Electron API or browser download
    await saveDataToFile(data, defaultFilename);
    
    // Check if this looks like a filesystem
    const chipName = currentChipName || '';
    const esptoolMod = await window.esptoolPackage;
    const fsType = esptoolMod.detectFilesystemFromImage(data, chipName);
    
    if (fsType !== 'unknown') {
      logMsg(`Detected ${fsType} filesystem in read data`);
      
      // Store the read data and metadata for later use
      lastReadFlashData = {
        data: data,
        offset: offset,
        size: size,
        fsType: fsType
      };
      
      // Show "Open FS Manager" button
      butOpenFSManager.classList.remove('hidden');
      logMsg('Click "Open FS Manager" to access the filesystem');
    } else {
      // Hide button if no filesystem detected
      butOpenFSManager.classList.add('hidden');
      lastReadFlashData = null;
    }

  } catch (e) {
    errorMsg("Failed to read flash: " + e);
  } finally {
    readProgress.classList.add("hidden");
    readProgress.querySelector("div").style.width = "0";
    butErase.disabled = false;
    baudRateSelect.disabled = false;
    butProgram.disabled = getValidFiles().length == 0;
    butReadFlash.disabled = false;
    readOffset.disabled = false;
    readSize.disabled = false;
  }
}

/**
 * @name clickOpenFSManager
 * Click handler for the Open FS Manager button (ESP8266)
 */
async function clickOpenFSManager() {
  if (!lastReadFlashData) {
    errorMsg('No filesystem data available. Please read flash first.');
    return;
  }
  
  try {
    // Create a pseudo-partition object for the read data
    const pseudoPartition = {
      name: `flash_0x${lastReadFlashData.offset.toString(16)}`,
      offset: lastReadFlashData.offset,
      size: lastReadFlashData.size,
      type: 0x01,
      subtype: lastReadFlashData.fsType === 'fatfs' ? 0x81 : 0x82,
      _readData: lastReadFlashData.data // Store the already-read data
    };
    
    await openFilesystem(pseudoPartition);
  } catch (e) {
    errorMsg(`Failed to open filesystem: ${e.message || e}`);
  }
}

/**
 * @name clickReadPartitions
 * Click handler for the read partitions button.
 */
async function clickReadPartitions() {
  const PARTITION_TABLE_OFFSET = 0x8000;
  const PARTITION_TABLE_SIZE = 0x1000; // Read 4KB to get all partitions

  butReadPartitions.disabled = true;
  butErase.disabled = true;
  butProgram.disabled = true;
  butReadFlash.disabled = true;

  try {
    logMsg("Reading partition table from 0x8000...");
    
    const data = await espStub.readFlash(PARTITION_TABLE_OFFSET, PARTITION_TABLE_SIZE);
    
    const partitions = parsePartitionTable(data);
    
    if (partitions.length === 0) {
      errorMsg("No valid partition table found");
      return;
    }

    logMsg(`Found ${partitions.length} partition(s)`);
    
    // Display partitions
    displayPartitions(partitions);
    
  } catch (e) {
    errorMsg("Failed to read partition table: " + e);
  } finally {
    butReadPartitions.disabled = false;
    butErase.disabled = false;
    butProgram.disabled = getValidFiles().length == 0;
    butReadFlash.disabled = false;
  }
}

/**
 * Parse partition table from binary data
 */
function parsePartitionTable(data) {
  const PARTITION_MAGIC = 0x50aa;
  const PARTITION_ENTRY_SIZE = 32;
  const partitions = [];

  for (let i = 0; i < data.length; i += PARTITION_ENTRY_SIZE) {
    const magic = data[i] | (data[i + 1] << 8);
    
    if (magic !== PARTITION_MAGIC) {
      break; // End of partition table
    }

    const type = data[i + 2];
    const subtype = data[i + 3];
    const offset = data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24);
    const size = data[i + 8] | (data[i + 9] << 8) | (data[i + 10] << 16) | (data[i + 11] << 24);
    
    // Read name (16 bytes, null-terminated)
    let name = "";
    for (let j = 12; j < 28; j++) {
      if (data[i + j] === 0) break;
      name += String.fromCharCode(data[i + j]);
    }

    const flags = data[i + 28] | (data[i + 29] << 8) | (data[i + 30] << 16) | (data[i + 31] << 24);

    // Get type names
    const typeNames = { 0x00: "app", 0x01: "data" };
    const appSubtypes = {
      0x00: "factory", 0x10: "ota_0", 0x11: "ota_1", 0x12: "ota_2",
      0x13: "ota_3", 0x14: "ota_4", 0x15: "ota_5", 0x20: "test"
    };
    const dataSubtypes = {
      0x00: "ota", 0x01: "phy", 0x02: "nvs", 0x03: "coredump",
      0x04: "nvs_keys", 0x05: "efuse", 0x81: "fat", 0x82: "spiffs"
    };

    const typeName = typeNames[type] || `0x${type.toString(16)}`;
    let subtypeName = "";
    if (type === 0x00) {
      subtypeName = appSubtypes[subtype] || `0x${subtype.toString(16)}`;
    } else if (type === 0x01) {
      subtypeName = dataSubtypes[subtype] || `0x${subtype.toString(16)}`;
    } else {
      subtypeName = `0x${subtype.toString(16)}`;
    }

    partitions.push({
      name,
      type,
      subtype,
      offset,
      size,
      flags,
      typeName,
      subtypeName
    });
  }

  return partitions;
}

/**
 * Display partitions in the UI
 */
function displayPartitions(partitions) {
  partitionList.innerHTML = "";
  partitionList.classList.remove("hidden");
  
  // Hide the Read Partition Table button after successful read
  butReadPartitions.classList.add("hidden");

  const table = document.createElement("table");
  table.className = "partition-table-display";
  
  // Header
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  ["Name", "Type", "SubType", "Offset", "Size", "Action"].forEach(text => {
    const th = document.createElement("th");
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement("tbody");
  partitions.forEach(partition => {
    const row = document.createElement("tr");
    
    // Name
    const nameCell = document.createElement("td");
    nameCell.setAttribute("data-label", "Name");
    nameCell.textContent = partition.name;
    row.appendChild(nameCell);
    
    // Type
    const typeCell = document.createElement("td");
    typeCell.setAttribute("data-label", "Type");
    typeCell.textContent = partition.typeName;
    row.appendChild(typeCell);
    
    // SubType
    const subtypeCell = document.createElement("td");
    subtypeCell.setAttribute("data-label", "SubType");
    subtypeCell.textContent = partition.subtypeName;
    row.appendChild(subtypeCell);
    
    // Offset
    const offsetCell = document.createElement("td");
    offsetCell.setAttribute("data-label", "Offset");
    offsetCell.textContent = `0x${partition.offset.toString(16)}`;
    row.appendChild(offsetCell);
    
    // Size
    const sizeCell = document.createElement("td");
    sizeCell.setAttribute("data-label", "Size");
    sizeCell.textContent = formatSize(partition.size);
    row.appendChild(sizeCell);
    
    // Action
    const actionCell = document.createElement("td");
    actionCell.setAttribute("data-label", "Action");
    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "Download";
    downloadBtn.className = "partition-download-btn";
    downloadBtn.onclick = () => downloadPartition(partition);
    actionCell.appendChild(downloadBtn);
    
    // Add "Open FS" button for data partitions with filesystem
    // 0x81 = FAT, 0x82 = SPIFFS (often contains LittleFS)
    if (partition.type === 0x01 && (partition.subtype === 0x81 || partition.subtype === 0x82)) {
      const fsBtn = document.createElement("button");
      fsBtn.textContent = "Open FS";
      fsBtn.className = "littlefs-fs-button";
      fsBtn.onclick = () => openFilesystem(partition);
      actionCell.appendChild(fsBtn);
    }
    
    row.appendChild(actionCell);
    
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  
  partitionList.appendChild(table);
}

/**
 * Download a partition
 */
async function downloadPartition(partition) {
  // Create filename with chip type and MAC address
  const chipInfo = currentChipName ? currentChipName.replace(/\s+/g, '_') : 'ESP';
  const macInfo = currentMacAddr ? currentMacAddr.replace(/:/g, '') : '';
  const defaultFilename = `${chipInfo}${macInfo ? '_' + macInfo : ''}_${partition.name}_0x${partition.offset.toString(16)}.bin`;

  const partitionProgress = document.getElementById("partitionProgress");
  const progressBar = partitionProgress.querySelector("div");

  try {
    partitionProgress.classList.remove("hidden");
    progressBar.style.width = "0%";

    logMsg(
      `Downloading partition "${partition.name}" (${formatSize(partition.size)})...`
    );

    const data = await espStub.readFlash(
      partition.offset,
      partition.size,
      (packet, progress, totalSize) => {
        const percent = Math.floor((progress / totalSize) * 100);
        progressBar.style.width = percent + "%";
      }
    );

    // Save file using Electron API or browser download
    await saveDataToFile(data, defaultFilename);

    logMsg(`Partition "${partition.name}" downloaded successfully`);
  } catch (e) {
    errorMsg(`Failed to download partition: ${e}`);
  } finally {
    partitionProgress.classList.add("hidden");
    progressBar.style.width = "0%";
  }
}

/**
 * Format size in human-readable format
 */
function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}

/**
 * @name clickClear
 * Click handler for the clear button.
 */
async function clickClear() {
// reset();     Reset function wasnt declared.
  log.innerHTML = "";
}

function convertJSON(chunk) {
  try {
    let jsonObj = JSON.parse(chunk);
    return jsonObj;
  } catch (e) {
    return chunk;
  }
}

function toggleUIToolbar(show) {
  isConnected = show;
  for (let i = 0; i < progress.length; i++) {
    progress[i].classList.add("hidden");
    progress[i].querySelector("div").style.width = "0";
  }
  if (show) {
    appDiv.classList.add("connected");
  } else {
    appDiv.classList.remove("connected");
  }
  butErase.disabled = !show;
  butReadFlash.disabled = !show;
  butReadPartitions.disabled = !show;
}

function toggleUIConnected(connected) {
  let lbl = "Connect";
  const header = document.querySelector(".header");
  const main = document.querySelector(".main");
  
  if (connected) {
    lbl = "Disconnect";
    isConnected = true;

  } else {
    isConnected = false;
    toggleUIToolbar(false);
    
    // Cleanup console if it was running
    if (consoleInstance) {
      consoleInstance.disconnect().catch(err => {
        debugMsg("Error disconnecting console: " + err);
      });
      consoleInstance = null;
    }
    
    // Hide console container, show commands, and uncheck switch
    consoleContainer.classList.add("hidden");
    const commands = document.getElementById("commands");
    if (commands) commands.classList.remove("hidden");
    consoleSwitch.checked = false;
    saveSetting("console", false);
  }
  butConnect.textContent = lbl;
}

function loadAllSettings() {
  // Get default values based on environment (Desktop vs WebUSB)
  const defaults = getDefaultAdvancedParams();
  
  // Load all saved settings or defaults
  autoscroll.checked = loadSetting("autoscroll", true);
  baudRateSelect.value = loadSetting("baudrate", 2000000);
  darkMode.checked = loadSetting("darkmode", false);
  debugMode.checked = loadSetting("debugmode", false);
  showLog.checked = loadSetting("showlog", false);
  consoleSwitch.checked = loadSetting("console", false);
  advancedMode.checked = loadSetting("advanced", false);
  
  // Load advanced parameters with environment-specific defaults
  chunkSizeSelect.value = loadSetting("chunkSize", defaults.chunkSize);
  blockSizeSelect.value = loadSetting("blockSize", defaults.blockSize);
  maxInFlightSelect.value = loadSetting("maxInFlight", defaults.maxInFlight);
  
  // Apply show log setting
  updateLogVisibility();
  
  // Don't show console container here - it will be initialized after connect
  // if consoleSwitch.checked is true
  
  // Apply advanced mode visibility
  updateAdvancedVisibility();
}

function loadSetting(setting, defaultValue) {
  let value = JSON.parse(window.localStorage.getItem(setting));
  if (value == null) {
    return defaultValue;
  }

  return value;
}

function saveSetting(setting, value) {
  window.localStorage.setItem(setting, JSON.stringify(value));
}

function ucWords(text) {
  return text
    .replace("_", " ")
    .toLowerCase()
    .replace(/(?<= )[^\s]|^./g, (a) => a.toUpperCase());
}

/**
 * Save data to file - uses Electron API in desktop app, browser download otherwise
 */
async function saveDataToFile(data, defaultFilename) {
  if (isElectron) {
    // Use Electron's native save dialog
    const result = await window.electronAPI.saveFile(
      Array.from(data), // Convert Uint8Array to regular array for IPC
      defaultFilename
    );
    
    if (result.success) {
      logMsg(`File saved: ${result.filePath}`);
    } else if (result.canceled) {
      logMsg("Save cancelled by user");
    } else {
      errorMsg(`Failed to save file: ${result.error}`);
    }
  } else {
    // Browser fallback - use download link
    const blob = new Blob([data], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logMsg(`Flash data downloaded as "${defaultFilename}"`);
  }
}

/**
 * Read file from disk - uses Electron API in desktop app
 */
async function readFileFromDisk() {
  if (isElectron) {
    const result = await window.electronAPI.openFile();
    
    if (result.success) {
      return {
        data: new Uint8Array(result.data),
        filename: result.filename,
        filePath: result.filePath
      };
    } else if (result.canceled) {
      return null;
    } else {
      throw new Error(result.error);
    }
  }
  return null;
}


/**
 * Open and mount a filesystem partition
 */
async function openFilesystem(partition) {
  try {
    logMsg(`Detecting filesystem type for partition "${partition.name}"...`);
    
    // Detect filesystem type
    const fsType = await detectFilesystemType(partition.offset, partition.size);
    
    if (fsType === 'littlefs') {
      await openLittleFS(partition);
    } else if (fsType === 'fatfs') {
      await openFatFS(partition);
    } else if (fsType === 'spiffs') {
      await openSPIFFS(partition);
    } else {
      errorMsg('Unknown filesystem type. Cannot open partition.');
    }
  } catch (e) {
    errorMsg(`Failed to open filesystem: ${e.message || e}`);
  }
}

/**
 * Detect filesystem type by reading partition header
 * 
 * Uses the centralized detectFilesystemFromImage function from the esptool module.
 * This function properly validates filesystem structures:
 * 
 * - LittleFS: Validates superblock at block 0/1 with "littlefs" magic at offset 8 and version check
 * - FatFS: Checks for FAT boot signature (0xAA55) and FAT signature strings
 * - SPIFFS: Checks for SPIFFS magic number (0x20140529)
 * 
 * Falls back to SPIFFS if no filesystem is detected.
 */
async function detectFilesystemType(offset, size) {
  try {
    // Read first 8KB or entire partition if smaller
    const readSize = Math.min(8192, size);
    const data = await espStub.readFlash(offset, readSize);
    
    if (data.length < 32) {
      logMsg('Partition too small, assuming SPIFFS');
      return 'spiffs';
    }
    
    // Get chip name for ESP8266-specific detection
    const chipName = currentChipName || '';
    
    // Use the detectFilesystemFromImage function from esptool package
    const esptoolMod = await window.esptoolPackage;
    const fsType = esptoolMod.detectFilesystemFromImage(data, chipName);
    
    // Convert FilesystemType enum to lowercase string
    const fsTypeStr = fsType.toLowerCase();
    
    if (fsTypeStr !== 'unknown') {
      logMsg(`Detected filesystem: ${fsTypeStr}`);
      return fsTypeStr;
    }
    
    // Default: If no clear signature found, assume SPIFFS
    logMsg('No clear filesystem signature found, assuming SPIFFS');
    return 'spiffs';
    
  } catch (err) {
    errorMsg(`Failed to detect filesystem type: ${err.message || err}`);
    return 'spiffs'; // Safe fallback
  }
}

/**
 * Lazy-load and cache the LittleFS WASM module
 */
async function loadLittlefsModule() {
  if (!littlefsModulePromise) {
    // Derive base path from current document URL (works for all hosting layouts)
    const basePath = new URL(".", window.location.href).pathname;
    const modulePath = `${basePath}src/wasm/littlefs/index.js`;
    
    littlefsModulePromise = import(modulePath)
      .catch(error => {
        errorMsg('Failed to load LittleFS module from: ' + modulePath);
        debugMsg('LittleFS module load error: ' + error);
        littlefsModulePromise = null; // Reset on error so it can be retried
        throw error;
      });
  }
  return littlefsModulePromise;
}

/**
 * Reset LittleFS state
 */
function resetLittleFSState() {
  // Clean up existing filesystem instance
  if (currentLittleFS) {
    try {
      // Don't call destroy() - it can cause crashes
      // Just let garbage collection handle it
    } catch (e) {
      debugMsg('Error cleaning up LittleFS: ' + e);
    }
  }
  
  currentLittleFS = null;
  currentLittleFSPartition = null;
  currentLittleFSPath = '/';
  currentLittleFSBlockSize = 4096;
  
  // Hide UI - safely check if elements exist
  try {
    if (littlefsManager) {
      littlefsManager.classList.add('hidden');
    }
    
    // Clear file list
    if (littlefsFileList) {
      littlefsFileList.innerHTML = '';
    }
  } catch (e) {
    debugMsg('Error resetting LittleFS UI: ' + e);
  }
}

/**
 * Open LittleFS partition
 */
async function openLittleFS(partition) {
  try {
    logMsg(`Reading LittleFS partition "${partition.name}" (${formatSize(partition.size)})...`);
    
    let data;
    
    // Check if data was already read (from Read Flash button)
    if (partition._readData) {
      data = partition._readData;
      logMsg('Using already-read flash data');
    } else {
      // Read entire partition
      const partitionProgress = document.getElementById("partitionProgress");
      const progressBar = partitionProgress.querySelector("div");
      partitionProgress.classList.remove("hidden");
      
      data = await espStub.readFlash(
        partition.offset,
        partition.size,
        (packet, progress, totalSize) => {
          const percent = Math.floor((progress / totalSize) * 100);
          progressBar.style.width = percent + "%";
        }
      );
      
      partitionProgress.classList.add("hidden");
      progressBar.style.width = "0%";
    }
    
    logMsg('Mounting LittleFS filesystem...');
    
    // Import constants from esptool module
    const basePath = new URL(".", window.location.href).pathname;
    const esptoolModulePath = `${basePath}js/modules/esptool.js`;
    const { 
      LITTLEFS_BLOCK_SIZE_CANDIDATES,
      ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES 
    } = await import(esptoolModulePath);
    
    // Get chip-specific block sizes using defined constants
    const chipName = currentChipName || '';
    const isESP8266 = chipName.toUpperCase().includes("ESP8266");
    const blockSizes = isESP8266 ? ESP8266_LITTLEFS_BLOCK_SIZE_CANDIDATES : LITTLEFS_BLOCK_SIZE_CANDIDATES;
    
    let fs = null;
    let blockSize = 0;
    
    // Use cached module loader
    const module = await loadLittlefsModule();
    const { createLittleFSFromImage, formatDiskVersion } = module;
    
    for (const bs of blockSizes) {
      try {
        const blockCount = Math.floor(partition.size / bs);
        
        // ESP8266-specific parameters (from main.py)
        const mountOptions = isESP8266 ? {
          blockSize: bs,
          blockCount: blockCount,
          readSize: 64,
          progSize: 64,
          cacheSize: 64,
          lookaheadSize: 64,
          nameMax: 32,
          blockCycles: 16,
        } : {
          blockSize: bs,
          blockCount: blockCount,
        };
        
        fs = await createLittleFSFromImage(data, mountOptions);
        
        // Try to list root to verify it works
        fs.list('/');
        blockSize = bs;
        logMsg(`Successfully mounted LittleFS with block size ${bs}${isESP8266 ? ' (ESP8266 parameters)' : ''}`);
        break;
      } catch (err) {
        // Try next block size
        // Don't call destroy() - just let it be garbage collected
        fs = null;
      }
    }
    
    if (!fs) {
      throw new Error('Failed to mount LittleFS with any block size');
    }
    
    // Store filesystem instance
    currentLittleFS = fs;
    currentLittleFSPartition = partition;
    currentLittleFSPath = '/';
    currentLittleFSBlockSize = blockSize;
    currentFilesystemType = 'littlefs';
    
    // Update UI
    littlefsPartitionName.textContent = partition.name;
    littlefsPartitionSize.textContent = formatSize(partition.size);
    
    // Get disk version
    try {
      const diskVer = fs.getDiskVersion();
      const major = (diskVer >> 16) & 0xFFFF;
      const minor = diskVer & 0xFFFF;
      littlefsDiskVersion.textContent = `LittleFS v${major}.${minor}`;
    } catch (e) {
      littlefsDiskVersion.textContent = '';
    }
    
    // Show manager
    littlefsManager.classList.remove('hidden');
    
    // Enable all operations for LittleFS (including directories)
    butLittlefsUpload.disabled = false;
    butLittlefsMkdir.disabled = false;
    butLittlefsWrite.disabled = false;
    
    // Load files
    refreshLittleFS();
    
    logMsg('LittleFS filesystem opened successfully');
  } catch (e) {
    errorMsg(`Failed to open LittleFS: ${e.message || e}`);
    // Don't call destroy() - just reset state
    resetLittleFSState();
  }
}

/**
 * Open FatFS partition
 */
async function openFatFS(partition) {
  try {
    logMsg(`Reading FatFS partition "${partition.name}" (${formatSize(partition.size)})...`);
    
    let data;
    
    // Check if data was already read (from Read Flash button)
    if (partition._readData) {
      data = partition._readData;
      logMsg('Using already-read flash data');
    } else {
      // Read entire partition
      const partitionProgress = document.getElementById("partitionProgress");
      const progressBar = partitionProgress.querySelector("div");
      partitionProgress.classList.remove("hidden");
      
      data = await espStub.readFlash(
        partition.offset,
        partition.size,
        (packet, progress, totalSize) => {
          const percent = Math.floor((progress / totalSize) * 100);
          progressBar.style.width = percent + "%";
        }
      );
      
      partitionProgress.classList.add("hidden");
      progressBar.style.width = "0%";
    }
    
    logMsg('Mounting FatFS filesystem...');
    logMsg(`Partition size: ${formatSize(partition.size)} (${partition.size} bytes)`);
    
    // Check if FAT filesystem starts at offset 0x1000 (common for ESP8266/ESP32)
    let fatOffset = 0;
    if (data.length >= 0x1000 + 512) {
      const bootSigAt0 = data[510] | (data[511] << 8);
      const bootSigAt0x1000 = data[0x1000 + 510] | (data[0x1000 + 511] << 8);
      
      // If boot signature is at 0x1000 but not at 0, use offset 0x1000
      if (bootSigAt0x1000 === 0xaa55 && bootSigAt0 !== 0xaa55) {
        fatOffset = 0x1000;
        logMsg(`Detected FAT filesystem at offset 0x${fatOffset.toString(16)}`);
        // Slice data to start from FAT offset
        data = data.slice(fatOffset);
      }
    }
    
    // Load FatFS module
    const basePath = new URL(".", window.location.href).pathname;
    const modulePath = `${basePath}src/wasm/fatfs/index.js`;
    const module = await import(modulePath);
    const { createFatFSFromImage, createFatFS } = module;
    
    // Use 4096 block size (ESP32 standard)
    let blockSize = 4096;
    let blockCount = Math.max(1, Math.floor(data.length / blockSize));
    if (blockCount <= 0) {
      blockCount = 1;
    }
    
    let fs = null;
    
    // First try to mount existing FatFS from image
    try {
      logMsg(`Trying to mount FatFS with block size ${blockSize} (${blockCount} blocks)...`);
      
      fs = await createFatFSFromImage(data, {
        blockSize: blockSize,
        blockCount: blockCount,
      });
      
      logMsg(`FatFS instance created, attempting to list files...`);
      const files = fs.list();
      logMsg(`Successfully listed ${files.length} files/directories`);
      logMsg(`Successfully mounted FatFS`);
    } catch (err) {
      logMsg(`Failed to mount existing FatFS: ${err.message || err}`);
      
      // If mounting fails, create a new empty formatted filesystem
      // Note: This does NOT use the image data - it creates a blank filesystem
      if (createFatFS) {
        try {
          logMsg(`Creating new blank FatFS (not using image data)...`);
          fs = await createFatFS({
            blockSize: blockSize,
            blockCount: blockCount,
            formatOnInit: true,
          });
          logMsg(`Created new formatted FatFS`);
          logMsg(`Partition appears blank/unformatted. You can format and save to initialize it.`);
        } catch (createErr) {
          logMsg(`Failed to create new FatFS: ${createErr.message || createErr}`);
          throw err; // Throw original error
        }
      } else {
        throw err;
      }
    }
    
    if (!fs) {
      throw new Error('Failed to mount FatFS with any block size. The partition may not contain a valid FAT filesystem or may be corrupted.');
    }
    
    // Store filesystem instance and block size
    currentLittleFS = fs;
    currentLittleFSPartition = partition;
    currentLittleFSPath = '/';
    currentLittleFSBlockSize = blockSize;
    currentFilesystemType = 'fatfs';
    
    // Update UI
    littlefsPartitionName.textContent = partition.name;
    littlefsPartitionSize.textContent = formatSize(partition.size);
    littlefsDiskVersion.textContent = 'FAT';
    
    // Show manager
    littlefsManager.classList.remove('hidden');
    
    // Enable all operations for FatFS (including directories)
    butLittlefsUpload.disabled = false;
    butLittlefsMkdir.disabled = false;
    butLittlefsWrite.disabled = false;
    
    // Load files
    refreshLittleFS();
    
    logMsg('FatFS filesystem opened successfully');
  } catch (e) {
    errorMsg(`Failed to open FatFS: ${e.message || e}`);
    debugMsg('FatFS open error details: ' + e);
    resetLittleFSState();
  }
}

/**
 * Open SPIFFS partition
 */
async function openSPIFFS(partition) {
  try {
    logMsg(`Reading SPIFFS partition "${partition.name}" (${formatSize(partition.size)})...`);
    
    let data;
    
    // Check if data was already read (from Read Flash button)
    if (partition._readData) {
      data = partition._readData;
      logMsg('Using already-read flash data');
    } else {
      // Read entire partition
      const partitionProgress = document.getElementById("partitionProgress");
      const progressBar = partitionProgress.querySelector("div");
      partitionProgress.classList.remove("hidden");
      
      data = await espStub.readFlash(
        partition.offset,
        partition.size,
        (packet, progress, totalSize) => {
          const percent = Math.floor((progress / totalSize) * 100);
          progressBar.style.width = percent + "%";
        }
      );
      
      partitionProgress.classList.add("hidden");
      progressBar.style.width = "0%";
    }
    
    logMsg('Parsing SPIFFS filesystem...');
    logMsg(`Partition size: ${formatSize(partition.size)} (${partition.size} bytes)`);
    
    // Import SPIFFS module
    const basePath = new URL(".", window.location.href).pathname;
    const modulePath = `${basePath}js/modules/esptool.js`;

    const { 
      SpiffsFS, 
      SpiffsReader, 
      SpiffsBuildConfig, 
      DEFAULT_SPIFFS_CONFIG,
      ESP8266_SPIFFS_PAGE_SIZE,
      ESP8266_SPIFFS_BLOCK_SIZE
    } = await import(modulePath);
    
    // Get chip-specific parameters
    const chipName = currentChipName || '';
    const isESP8266 = chipName.toUpperCase().includes("ESP8266");
    
    // ESP8266 uses different SPIFFS parameters (from main.py)
    const pageSize = isESP8266 ? ESP8266_SPIFFS_PAGE_SIZE : DEFAULT_SPIFFS_CONFIG.pageSize || 256;
    const blockSize = isESP8266 ? ESP8266_SPIFFS_BLOCK_SIZE : DEFAULT_SPIFFS_CONFIG.blockSize || 4096;
    
    // Create build config with partition size and chip-specific parameters
    const config = new SpiffsBuildConfig({
      ...DEFAULT_SPIFFS_CONFIG,
      imgSize: partition.size,
      pageSize: pageSize,
      blockSize: blockSize,
    });
    
    logMsg(`Using SPIFFS config: page_size=${pageSize}, block_size=${blockSize}${isESP8266 ? ' (ESP8266)' : ''}`);
    
    // Create reader and parse existing files
    const reader = new SpiffsReader(data, config);
    reader.parse();
    
    // Get file list
    const files = reader.listFiles();
    logMsg(`Found ${files.length} files in SPIFFS`);
    
    // Create a wrapper object that mimics LittleFS interface with full read/write support
    const spiffsWrapper = {
      _reader: reader,
      _files: files,
      _partition: partition,
      _config: config,
      _originalData: data, // Store original image data
      _modified: false,
      
      list: function(path = '/') {
        // Normalize path
        const normalizedPath = path === '/' ? '' : path.replace(/^\//, '').replace(/\/$/, '');
        
        // Get all files with proper path property for UI compatibility
        const allFiles = this._files.map(f => {
          const fileName = f.name.startsWith('/') ? f.name.substring(1) : f.name;
          return {
            name: fileName,
            path: '/' + fileName, // Add path property for UI
            type: 'file',
            size: f.size,
            _data: f.data
          };
        });
        
        // If root, return all files
        if (!normalizedPath) {
          return allFiles;
        }
        
        // Filter by path prefix
        const prefix = normalizedPath + '/';
        return allFiles.filter(f => f.name.startsWith(prefix));
      },
      
      read: function(path) {
        const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
        const file = this._files.find(f => {
          const fname = f.name.startsWith('/') ? f.name.substring(1) : f.name;
          return fname === normalizedPath;
        });
        return file ? file.data : null;
      },
      
      readFile: function(path) {
        // Alias for read() to match LittleFS interface
        return this.read(path);
      },
      
      write: function(path, data) {
        // Determine the filename format used in original files
        // Check if original files have leading slash
        const hasLeadingSlash = this._files.length > 0 && this._files[0].name.startsWith('/');
        
        // Normalize path for comparison
        const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
        
        // Store filename in the same format as original files
        const storedName = hasLeadingSlash ? '/' + normalizedPath : normalizedPath;
        
        // Check if file already exists
        const existingIndex = this._files.findIndex(f => {
          const fname = f.name.startsWith('/') ? f.name.substring(1) : f.name;
          return fname === normalizedPath;
        });
        
        // Update or add file
        if (existingIndex >= 0) {
          this._files[existingIndex] = {
            name: storedName,
            size: data.length,
            data: data
          };
        } else {
          this._files.push({
            name: storedName,
            size: data.length,
            data: data
          });
        }
        
        this._modified = true;
      },
      
      writeFile: function(path, data) {
        // Alias for write() to match LittleFS interface
        return this.write(path, data);
      },
      
      addFile: function(path, data) {
        // Alias for write() to match alternative interface
        return this.write(path, data);
      },
      
      remove: function(path) {
        // Normalize path
        const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
        
        // Find and remove file
        const index = this._files.findIndex(f => {
          const fname = f.name.startsWith('/') ? f.name.substring(1) : f.name;
          return fname === normalizedPath;
        });
        
        if (index >= 0) {
          this._files.splice(index, 1);
          this._modified = true;
        } else {
          throw new Error(`File not found: ${path}`);
        }
      },
      
      deleteFile: function(path) {
        // Alias for remove() to match LittleFS interface
        return this.remove(path);
      },
      
      delete: function(path, options) {
        // For compatibility with LittleFS delete method
        // SPIFFS doesn't have directories, so just delete the file
        return this.remove(path);
      },
      
      mkdir: function() {
        throw new Error('SPIFFS does not support directories. Files are stored in a flat structure.');
      },
      
      toImage: function() {
        // If not modified, return original data
        if (!this._modified) {
          return this._originalData || new Uint8Array(this._partition.size);
        }
        
        // Create new SPIFFS filesystem with all files
        const fs = new SpiffsFS(this._partition.size, this._config);
        
        // Add all files - preserve original filename format
        for (const file of this._files) {
          // Use the filename exactly as stored in _files
          // This preserves whether it has a leading slash or not
          const fileName = file.name;
          
          // Log for debugging
          console.log(`Adding file to SPIFFS: "${fileName}" (${file.data.length} bytes)`);
          
          fs.createFile(fileName, file.data);
        }
        
        // Generate binary image
        const image = fs.toBinary();
        console.log(`Generated SPIFFS image: ${image.length} bytes`);
        return image;
      }
    };
    
    // Store filesystem instance
    currentLittleFS = spiffsWrapper;
    currentLittleFSPartition = partition;
    currentLittleFSPath = '/';
    currentLittleFSBlockSize = config.blockSize;
    currentFilesystemType = 'spiffs';
    
    // Update UI
    littlefsPartitionName.textContent = partition.name;
    littlefsPartitionSize.textContent = formatSize(partition.size);
    littlefsDiskVersion.textContent = 'SPIFFS';
    
    // Show manager
    littlefsManager.classList.remove('hidden');
    
    // Enable write operations for SPIFFS (but not mkdir since SPIFFS is flat)
    butLittlefsUpload.disabled = false;
    butLittlefsMkdir.disabled = true; // SPIFFS doesn't support directories
    butLittlefsWrite.disabled = false;
    
    // Load files
    refreshLittleFS();
    
    logMsg('SPIFFS filesystem opened successfully');
  } catch (e) {
    errorMsg(`Failed to open SPIFFS: ${e.message || e}`);
    debugMsg('SPIFFS open error details: ' + e);
    resetLittleFSState();
  }
}

/**
 * Estimate LittleFS storage footprint for a single file (data + metadata block)
 */
function littlefsEstimateFileFootprint(size) {
  const block = currentLittleFSBlockSize || 4096;
  const dataBytes = Math.max(1, Math.ceil(size / block)) * block;
  const metadataBytes = block; // per-file metadata block
  return dataBytes + metadataBytes;
}

/**
 * Estimate total LittleFS usage for a set of entries
 */
function littlefsEstimateUsage(entries) {
  const block = currentLittleFSBlockSize || 4096;
  let total = block * 2; // root metadata copies
  
  for (const entry of entries || []) {
    if (entry.type === 'dir') {
      total += block;
    } else {
      total += littlefsEstimateFileFootprint(entry.size || 0);
    }
  }
  
  return total;
}

/**
 * Refresh LittleFS file list
 */
function refreshLittleFS() {
  if (!currentLittleFS) return;
  
  try {
    // Calculate usage based on all files (like ESPConnect)
    const allFiles = currentLittleFS.list('/');
    const usedBytes = littlefsEstimateUsage(allFiles);
    const totalBytes = currentLittleFSPartition.size;
    const usedPercent = Math.round((usedBytes / totalBytes) * 100);
    
    littlefsUsageBar.style.width = usedPercent + '%';
    littlefsUsageText.textContent = `Used: ${formatSize(usedBytes)} / ${formatSize(totalBytes)} (${usedPercent}%)`;
    
    // Update breadcrumb
    littlefsBreadcrumb.textContent = currentLittleFSPath || '/';
    butLittlefsUp.disabled = currentLittleFSPath === '/' || !currentLittleFSPath;
    
    // List files - the list() function behavior differs between filesystems
    let entries;
    
    if (currentFilesystemType === 'fatfs') {
      // FatFS returns ALL files recursively from root, so we always list from root and filter
      const allEntries = currentLittleFS.list('/');
      const isRoot = currentLittleFSPath === '/';
      
      // Filter to show only direct children
      entries = allEntries.filter(entry => {
        // Remove /fatfs prefix from entry path for comparison
        let entryPath = entry.path;
        if (entryPath.startsWith('/fatfs/')) {
          entryPath = entryPath.slice(6);
        } else if (entryPath === '/fatfs') {
          entryPath = '/';
        }
        
        if (isRoot) {
          // In root: only show top-level entries
          const withoutLeadingSlash = entryPath.slice(1);
          return withoutLeadingSlash && !withoutLeadingSlash.includes('/');
        } else {
          // In subdirectory: entry must be direct child of current path
          const expectedPrefix = currentLittleFSPath + '/';
          if (!entryPath.startsWith(expectedPrefix)) {
            return false;
          }
          const relativePath = entryPath.slice(expectedPrefix.length);
          return relativePath && !relativePath.includes('/');
        }
      });
      
      // Add name attribute for FatFS entries
      entries = entries.map(entry => ({
        ...entry,
        name: entry.path.split('/').pop() || entry.path
      }));
    } else {
      // LittleFS and SPIFFS return only direct children
      entries = currentLittleFS.list(currentLittleFSPath);
    }
    
    // Clear table
    littlefsFileList.innerHTML = '';
    
    if (entries.length === 0) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="4" class="empty-state">No files in this directory</td>';
      littlefsFileList.appendChild(row);
      return;
    }
    
    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.path.localeCompare(b.path);
    });
    
    // Add rows
    entries.forEach(entry => {
      const row = document.createElement('tr');
      
      // Name
      const nameCell = document.createElement('td');
      nameCell.setAttribute('data-label', 'Name');
      const nameDiv = document.createElement('div');
      nameDiv.className = 'file-name' + (entry.type === 'dir' ? ' clickable' : '');
      
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = entry.type === 'dir' ? '📁' : '📄';
      
      // Use entry.name instead of parsing the path
      const name = entry.name || entry.path.split('/').filter(Boolean).pop() || '/';
      const nameText = document.createElement('span');
      nameText.textContent = name;
      
      nameDiv.appendChild(icon);
      nameDiv.appendChild(nameText);
      
      if (entry.type === 'dir') {
        nameDiv.onclick = () => navigateLittleFS(entry.path);
      }
      
      nameCell.appendChild(nameDiv);
      row.appendChild(nameCell);
      
      // Type
      const typeCell = document.createElement('td');
      typeCell.setAttribute('data-label', 'Type');
      typeCell.textContent = entry.type === 'dir' ? 'Directory' : 'File';
      row.appendChild(typeCell);
      
      // Size
      const sizeCell = document.createElement('td');
      sizeCell.setAttribute('data-label', 'Size');
      sizeCell.textContent = entry.type === 'file' ? formatSize(entry.size) : '-';
      row.appendChild(sizeCell);
      
      // Actions
      const actionsCell = document.createElement('td');
      actionsCell.setAttribute('data-label', 'Actions');
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'file-actions';
      
      if (entry.type === 'file') {
        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = 'Download';
        downloadBtn.onclick = () => downloadLittleFSFile(entry.path);
        actionsDiv.appendChild(downloadBtn);
        
        const viewBtn = document.createElement('button');
        viewBtn.textContent = 'View';
        viewBtn.onclick = () => viewLittleFSFile(entry.path);
        actionsDiv.appendChild(viewBtn);
      }
      
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.className = 'delete-btn';
      deleteBtn.onclick = () => deleteLittleFSFile(entry.path, entry.type);
      actionsDiv.appendChild(deleteBtn);
      
      actionsCell.appendChild(actionsDiv);
      row.appendChild(actionsCell);
      
      littlefsFileList.appendChild(row);
    });
  } catch (e) {
    errorMsg(`Failed to refresh file list: ${e.message || e}`);
  }
}

/**
 * Navigate to a directory in LittleFS
 */
function navigateLittleFS(path) {
  // Remove /fatfs prefix if present (for FatFS compatibility)
  let normalizedPath = path;
  if (normalizedPath.startsWith('/fatfs/')) {
    normalizedPath = normalizedPath.slice(6); // Remove '/fatfs' keeping the /
  } else if (normalizedPath === '/fatfs') {
    normalizedPath = '/';
  }
  
  // Remove trailing slash except for root
  if (normalizedPath !== '/' && normalizedPath.endsWith('/')) {
    normalizedPath = normalizedPath.slice(0, -1);
  }
  
  currentLittleFSPath = normalizedPath;
  refreshLittleFS();
}

/**
 * Navigate up one directory
 */
function clickLittlefsUp() {
  if (currentLittleFSPath === '/' || !currentLittleFSPath) return;
  
  // Split path and remove last segment
  const parts = currentLittleFSPath.split('/').filter(Boolean);
  parts.pop();
  
  // Reconstruct path
  currentLittleFSPath = parts.length ? '/' + parts.join('/') : '/';
  refreshLittleFS();
}

/**
 * Refresh button handler
 */
function clickLittlefsRefresh() {
  refreshLittleFS();
  logMsg(`${getFilesystemDisplayName()} file list refreshed`);
}

/**
 * Backup LittleFS image
 */
async function clickLittlefsBackup() {
  if (!currentLittleFS || !currentLittleFSPartition) return;
  
  try {
    logMsg(`Creating ${getFilesystemDisplayName()} backup image...`);
    const image = currentLittleFS.toImage();
    
    // Create filename with chip type and MAC address
    const chipInfo = currentChipName ? currentChipName.replace(/\s+/g, '_') : 'ESP';
    const macInfo = currentMacAddr ? currentMacAddr.replace(/:/g, '') : '';
    const fsType = currentFilesystemType || 'filesystem';
    const filename = `${chipInfo}${macInfo ? '_' + macInfo : ''}_${currentLittleFSPartition.name}_${fsType}_backup.bin`;
    await saveDataToFile(image, filename);
    
    logMsg(`${getFilesystemDisplayName()} backup saved as "${filename}"`);
  } catch (e) {
    errorMsg(`Failed to backup ${getFilesystemDisplayName()}: ${e.message || e}`);
  }
}

/**
 * Write LittleFS image to flash
 */
async function clickLittlefsWrite() {
  if (!currentLittleFS || !currentLittleFSPartition) return;
  
  const confirmed = confirm(
    `Write modified filesystem to flash?\n\n` +
    `Partition: ${currentLittleFSPartition.name}\n` +
    `Offset: 0x${currentLittleFSPartition.offset.toString(16)}\n` +
    `Size: ${formatSize(currentLittleFSPartition.size)}\n\n` +
    `This will overwrite the current filesystem on the device!`
  );
  
  if (!confirmed) return;
  
  try {
    logMsg(`Creating ${getFilesystemDisplayName()} image...`);
    const image = currentLittleFS.toImage();
    logMsg(`Image created: ${formatSize(image.length)}`);
    
    if (image.length > currentLittleFSPartition.size) {
      errorMsg(`Image size (${formatSize(image.length)}) exceeds partition size (${formatSize(currentLittleFSPartition.size)})`);
      return;
    }
    
    // Disable buttons during write
    butLittlefsRefresh.disabled = true;
    butLittlefsBackup.disabled = true;
    butLittlefsWrite.disabled = true;
    butLittlefsClose.disabled = true;
    butLittlefsUpload.disabled = true;
    butLittlefsMkdir.disabled = true;
    
    logMsg(`Writing ${formatSize(image.length)} to partition "${currentLittleFSPartition.name}" at 0x${currentLittleFSPartition.offset.toString(16)}...`);
    
    // Use the LittleFS usage bar as progress indicator
    const usageBar = document.getElementById("littlefsUsageBar");
    const usageText = document.getElementById("littlefsUsageText");
    const originalUsageBarWidth = usageBar.style.width;
    const originalUsageText = usageText.textContent;
    
    // Convert Uint8Array to ArrayBuffer (CRITICAL: flashData expects ArrayBuffer, not Uint8Array)
    // This matches the ESPConnect implementation
    const imageBuffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength);
    
    // Write the image to flash with progress indication
    await espStub.flashData(
      imageBuffer,
      (bytesWritten, totalBytes) => {
        const percent = Math.floor((bytesWritten / totalBytes) * 100);
        usageBar.style.width = percent + "%";
        usageText.textContent = `Writing: ${formatSize(bytesWritten)} / ${formatSize(totalBytes)} (${percent}%)`;
      },
      currentLittleFSPartition.offset
    );
    
    // Restore original usage display
    usageBar.style.width = originalUsageBarWidth;
    usageText.textContent = originalUsageText;
    
    logMsg(`${getFilesystemDisplayName()} successfully written to flash!`);
    logMsg(`To use the new filesystem, reset your device.`);
    
  } catch (e) {
    errorMsg(`Failed to write ${getFilesystemDisplayName()} to flash: ${e.message || e}`);
  } finally {
    // Re-enable buttons
    butLittlefsRefresh.disabled = false;
    butLittlefsBackup.disabled = false;
    butLittlefsWrite.disabled = false;
    butLittlefsClose.disabled = false;
    butLittlefsUpload.disabled = !littlefsFileInput.files.length;
    // Re-enable mkdir only if not SPIFFS
    butLittlefsMkdir.disabled = (currentFilesystemType === 'spiffs');
  }
}

/**
 * Close LittleFS manager
 */
function clickLittlefsClose() {
  const fsName = getFilesystemDisplayName() || 'Filesystem';
  
  if (currentLittleFS) {
    try {
      // Only call destroy if it exists (LittleFS has it, FatFS/SPIFFS don't)
      if (typeof currentLittleFS.destroy === 'function') {
        currentLittleFS.destroy();
      }
    } catch (e) {
      debugMsg(`Error destroying ${fsName}: ` + e);
    }
    currentLittleFS = null;
  }
  
  currentLittleFSPartition = null;
  currentLittleFSPath = '/';
  currentFilesystemType = null;
  littlefsManager.classList.add('hidden');
  logMsg(`${fsName} manager closed`);
}

/**
 * Upload file to LittleFS
 */
async function clickLittlefsUpload() {
  if (!currentLittleFS || !littlefsFileInput.files.length) return;
  
  const file = littlefsFileInput.files[0];
  
  try {
    logMsg(`Uploading file "${file.name}"...`);
    
    const data = await file.arrayBuffer();
    const uint8Data = new Uint8Array(data);
    
    // Construct target path
    let targetPath = currentLittleFSPath;
    if (!targetPath.endsWith('/')) targetPath += '/';
    targetPath += file.name;
    
    // Ensure parent directories exist
    const segments = targetPath.split('/').filter(Boolean);
    if (segments.length > 1) {
      let built = '';
      for (let i = 0; i < segments.length - 1; i++) {
        built += `/${segments[i]}`;
        try {
          currentLittleFS.mkdir(built);
        } catch (e) {
          // Ignore if directory already exists
        }
      }
    }
    
    // Write file to LittleFS - EXACTLY like ESPConnect
    if (typeof currentLittleFS.writeFile === 'function') {
      currentLittleFS.writeFile(targetPath, uint8Data);
    } else if (typeof currentLittleFS.addFile === 'function') {
      currentLittleFS.addFile(targetPath, uint8Data);
    }
    
    // Verify by reading back
    const readBack = currentLittleFS.readFile(targetPath);
    logMsg(`File written: ${readBack.length} bytes at ${targetPath}`);
    
    // Clear input
    littlefsFileInput.value = '';
    butLittlefsUpload.disabled = true;
    
    // Refresh list
    refreshLittleFS();
    
    logMsg(`File "${file.name}" uploaded successfully`);
  } catch (e) {
    errorMsg(`Failed to upload file: ${e.message || e}`);
  }
}

/**
 * Create new directory
 */
async function clickLittlefsMkdir() {
  if (!currentLittleFS) return;
  
  // Check if mkdir is supported (SPIFFS doesn't support directories)
  if (currentFilesystemType === 'spiffs') {
    errorMsg('SPIFFS does not support directories. Files are stored in a flat structure.');
    return;
  }
  
  let dirName;
  if (isElectron) {
    dirName = await window.electronAPI.showPrompt('Enter directory name:');
  } else {
    dirName = prompt('Enter directory name:');
  }
  
  if (!dirName || !dirName.trim()) return;
  
  try {
    let targetPath = currentLittleFSPath;
    if (!targetPath.endsWith('/')) targetPath += '/';
    targetPath += dirName.trim();
    
    currentLittleFS.mkdir(targetPath);
    refreshLittleFS();
    
    logMsg(`Directory "${dirName}" created successfully`);
  } catch (e) {
    errorMsg(`Failed to create directory: ${e.message || e}`);
  }
}

/**
 * Download file from LittleFS
 */
async function downloadLittleFSFile(path) {
  if (!currentLittleFS) return;
  
  try {
    logMsg(`Downloading file "${path}"...`);
    
    const data = currentLittleFS.readFile(path);
    const filename = path.split('/').filter(Boolean).pop() || 'file.bin';
    
    await saveDataToFile(data, filename);
    
    logMsg(`File "${filename}" downloaded successfully`);
  } catch (e) {
    errorMsg(`Failed to download file: ${e.message || e}`);
  }
}

/**
 * Delete file or directory from LittleFS
 */
function deleteLittleFSFile(path, type) {
  if (!currentLittleFS) return;
  
  const name = path.split('/').filter(Boolean).pop() || path;
  const confirmed = confirm(`Delete ${type} "${name}"?`);
  
  if (!confirmed) return;
  
  try {
    if (type === 'dir') {
      currentLittleFS.delete(path, { recursive: true });
    } else {
      currentLittleFS.deleteFile(path);
    }
    
    refreshLittleFS();
    logMsg(`${type === 'dir' ? 'Directory' : 'File'} "${name}" deleted successfully`);
  } catch (e) {
    errorMsg(`Failed to delete ${type}: ${e.message || e}`);
  }
}

/**
 * View file content in modal
 */
async function viewLittleFSFile(path) {
  if (!currentLittleFS) return;
  
  try {
    logMsg(`Loading file "${path}"...`);
    
    const data = currentLittleFS.readFile(path);
    const filename = path.split('/').filter(Boolean).pop() || 'file';
    
    // Store current file data
    currentViewedFile = path;
    currentViewedFileData = data;
    
    // Update modal info
    fileViewerTitle.textContent = filename;
    fileViewerPath.textContent = path;
    fileViewerSize.textContent = formatSize(data.length);
    
    // Show text view by default
    switchViewerTab('text');
    
    // Show modal
    fileViewerModal.classList.remove('hidden');
    
    logMsg(`File "${filename}" loaded successfully`);
  } catch (e) {
    errorMsg(`Failed to view file: ${e.message || e}`);
  }
}

/**
 * Close file viewer modal
 */
function closeFileViewer() {
  fileViewerModal.classList.add('hidden');
  currentViewedFile = null;
  currentViewedFileData = null;
}

/**
 * Download file from viewer
 */
async function downloadFromViewer() {
  if (!currentViewedFile || !currentViewedFileData) return;
  
  const filename = currentViewedFile.split('/').filter(Boolean).pop() || 'file.bin';
  await saveDataToFile(currentViewedFileData, filename);
  logMsg(`File "${filename}" downloaded from viewer`);
}

/**
 * Switch between text and hex view
 */
function switchViewerTab(mode) {
  if (!currentViewedFileData) return;
  
  // Update tab buttons
  if (mode === 'text') {
    tabText.classList.add('active');
    tabHex.classList.remove('active');
    displayTextView(currentViewedFileData);
  } else {
    tabHex.classList.add('active');
    tabText.classList.remove('active');
    displayHexView(currentViewedFileData);
  }
}

/**
 * Display file content as text
 */
function displayTextView(data) {
  try {
    // Try to decode as UTF-8
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(data);
    
    fileViewerText.textContent = text;
    fileViewerText.className = '';
  } catch (e) {
    fileViewerText.textContent = 'Unable to display as text. Try Hex view.';
  }
}

/**
 * Display file content as hex dump
 */
function displayHexView(data) {
  const lines = [];
  const bytesPerLine = 16;
  
  for (let i = 0; i < data.length; i += bytesPerLine) {
    const offset = i.toString(16).padStart(8, '0').toUpperCase();
    
    // Hex bytes
    const hexBytes = [];
    const asciiChars = [];
    
    for (let j = 0; j < bytesPerLine; j++) {
      if (i + j < data.length) {
        const byte = data[i + j];
        hexBytes.push(byte.toString(16).padStart(2, '0').toUpperCase());
        
        // ASCII representation (printable characters only)
        if (byte >= 32 && byte <= 126) {
          asciiChars.push(String.fromCharCode(byte));
        } else {
          asciiChars.push('.');
        }
      } else {
        hexBytes.push('  ');
        asciiChars.push(' ');
      }
    }
    
    // Format: offset | hex bytes (grouped by 8) | ascii
    const hexPart1 = hexBytes.slice(0, 8).join(' ');
    const hexPart2 = hexBytes.slice(8, 16).join(' ');
    const hexPart = hexPart1 + '  ' + hexPart2;
    const asciiPart = asciiChars.join('');
    
    lines.push(
      `<div class="hex-line">` +
      `<span class="hex-offset">${offset}</span>` +
      `<span class="hex-bytes">${hexPart}</span>` +
      `<span class="hex-ascii">${asciiPart}</span>` +
      `</div>`
    );
  }
  
  fileViewerText.innerHTML = `<div class="hex-view">${lines.join('')}</div>`;
  fileViewerText.className = 'hex-view';
}

// Close modal when clicking outside
fileViewerModal.addEventListener('click', (e) => {
  if (e.target === fileViewerModal) {
    closeFileViewer();
  }
});
