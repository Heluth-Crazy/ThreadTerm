/**
 * Auto Updater Module
 * OpenWork Desktop - Automatic Update Functionality
 *
 * Features:
 * - Automatic update checking on startup
 * - Manual update checking via menu/IPC
 * - Update download progress tracking
 * - Silent background updates
 * - User notification for available updates
 */

const { autoUpdater } = require('electron-updater');
const { dialog, ipcMain, BrowserWindow } = require('electron');
const path = require('path');

// Update check interval (24 hours)
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

// State tracking
let updateCheckTimer = null;
let mainWindow = null;
let isUpdateAvailable = false;
let updateDownloaded = false;

/**
 * Initialize the auto updater
 * @param {BrowserWindow} window - Main browser window
 */
function initUpdater(window) {
  mainWindow = window;

  // Configure auto updater
  configureAutoUpdater();

  // Set up event handlers
  setupEventHandlers();

  // Set up IPC handlers
  setupIpcHandlers();

  // Check for updates on startup (with delay to not block app launch)
  setTimeout(() => {
    checkForUpdates(false);
  }, 5000);

  // Set up periodic update checks
  startPeriodicChecks();

  console.log('[Updater] Auto updater initialized');
}

/**
 * Configure auto updater settings
 */
function configureAutoUpdater() {
  // Enable automatic download
  autoUpdater.autoDownload = true;

  // Don't automatically install on quit (let user decide)
  autoUpdater.autoInstallOnAppQuit = false;

  // Set logger
  autoUpdater.logger = console;
  // File transport may not be available in development mode
  if (autoUpdater.logger && autoUpdater.logger.transports && autoUpdater.logger.transports.file) {
    autoUpdater.logger.transports.file.level = 'info';
  }

  // Configure update feed URL if needed (electron-builder.yml should handle this)
  // autoUpdater.setFeedURL({
  //   provider: 'github',
  //   owner: 'openwork',
  //   repo: 'openwork'
  // });
}

/**
 * Set up auto updater event handlers
 */
function setupEventHandlers() {
  // Update available
  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version);
    isUpdateAvailable = true;

    // Notify renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      });
    }

    // Show notification dialog (only for manual checks)
    if (info.manualCheck) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `A new version (${info.version}) is available.`,
        detail: 'The update will be downloaded in the background.',
        buttons: ['OK']
      });
    }
  });

  // Update not available
  autoUpdater.on('update-not-available', (info) => {
    console.log('[Updater] No updates available');
    isUpdateAvailable = false;

    // Notify renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-not-available', {
        version: info.version
      });
    }

    // Show notification only for manual checks
    if (info.manualCheck) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'No Updates',
        message: 'You are running the latest version.',
        detail: `Current version: ${info.version}`,
        buttons: ['OK']
      });
    }
  });

  // Download progress
  autoUpdater.on('download-progress', (progressObj) => {
    const percent = Math.round(progressObj.percent);
    const transferred = formatBytes(progressObj.transferred);
    const total = formatBytes(progressObj.total);
    const speed = formatBytes(progressObj.bytesPerSecond) + '/s';

    console.log(`[Updater] Download progress: ${percent}% (${transferred}/${total} at ${speed})`);

    // Notify renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', {
        percent,
        transferred,
        total,
        speed
      });
    }
  });

  // Update downloaded
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    updateDownloaded = true;

    // Notify renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', {
        version: info.version,
        releaseNotes: info.releaseNotes
      });
    }

    // Show install dialog
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'The update will be installed when you restart the application.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    }).then((result) => {
      if (result.response === 0) {
        // Restart and install
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  // Error handling
  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error);

    // Notify renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', {
        message: error.message
      });
    }

    // Show error dialog only for manual checks
    if (error.manualCheck) {
      dialog.showErrorBox(
        'Update Error',
        `Failed to check for updates: ${error.message}`
      );
    }
  });
}

/**
 * Set up IPC handlers for update operations
 */
function setupIpcHandlers() {
  // Check for updates (manual)
  ipcMain.handle('check-for-updates', async () => {
    return await checkForUpdates(true);
  });

  // Download update
  ipcMain.handle('download-update', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      console.error('[Updater] Failed to download update:', error);
      return { success: false, error: error.message };
    }
  });

  // Install update
  ipcMain.handle('install-update', () => {
    if (updateDownloaded) {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    }
    return { success: false, error: 'No update downloaded' };
  });

  // Get update status
  ipcMain.handle('get-update-status', () => {
    return {
      isUpdateAvailable,
      updateDownloaded,
      currentVersion: autoUpdater.currentVersion
    };
  });
}

/**
 * Check for updates
 * @param {boolean} manual - Whether this is a manual check (shows dialogs)
 * @returns {Promise<Object>} Update check result
 */
async function checkForUpdates(manual = false) {
  try {
    console.log(`[Updater] Checking for updates (manual: ${manual})...`);

    // Set flag for event handlers to know if this was manual
    const checkOptions = { manualCheck: manual };

    const result = await autoUpdater.checkForUpdates();

    // Attach manual check flag to result for event handlers
    if (result && result.updateInfo) {
      result.updateInfo.manualCheck = manual;
    }

    return {
      success: true,
      updateAvailable: result && result.updateInfo && result.updateInfo.version !== autoUpdater.currentVersion,
      version: result ? result.updateInfo.version : null
    };
  } catch (error) {
    console.error('[Updater] Failed to check for updates:', error);

    if (manual) {
      error.manualCheck = true;
      dialog.showErrorBox(
        'Update Check Failed',
        `Could not check for updates: ${error.message}`
      );
    }

    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Start periodic update checks
 */
function startPeriodicChecks() {
  // Clear existing timer if any
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
  }

  // Set up new timer
  updateCheckTimer = setInterval(() => {
    console.log('[Updater] Running periodic update check');
    checkForUpdates(false);
  }, UPDATE_CHECK_INTERVAL);
}

/**
 * Stop periodic update checks
 */
function stopPeriodicChecks() {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
}

/**
 * Format bytes to human readable string
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get current update status
 * @returns {Object} Current update status
 */
function getStatus() {
  return {
    isUpdateAvailable,
    updateDownloaded,
    currentVersion: autoUpdater.currentVersion?.version || 'unknown'
  };
}

/**
 * Clean up updater resources
 */
function cleanup() {
  stopPeriodicChecks();
  mainWindow = null;
}

module.exports = {
  initUpdater,
  checkForUpdates,
  getStatus,
  cleanup,
  startPeriodicChecks,
  stopPeriodicChecks
};
