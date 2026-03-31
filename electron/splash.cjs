/**
 * Splash Screen Module
 * OpenWork Desktop - Application Startup Loading Screen
 *
 * Features:
 * - Frameless splash window (400x300)
 * - Loading progress display
 * - Server startup status monitoring
 * - Auto-close on main window ready
 * - Timeout handling (15 seconds)
 */

const { BrowserWindow } = require('electron');
const path = require('path');

// Splash window reference
let splashWindow = null;
let splashRendererReady = false;
let latestSplashState = {
  progress: 0,
  message: 'Initializing...',
};

// Configuration
const SPLASH_WIDTH = 400;
const SPLASH_HEIGHT = 300;
const SPLASH_TIMEOUT = 15000; // 15 seconds

/**
 * Create and show the splash screen window
 * @returns {BrowserWindow} The splash window instance
 */
function createSplashWindow() {
  if (splashWindow) {
    return splashWindow;
  }

  splashWindow = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Set Content Security Policy for splash window
  const cspPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';";

  splashWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspPolicy]
      }
    });
  });

  // Load the splash HTML
  const splashHtmlPath = path.join(__dirname, 'splash.html');
  splashWindow.loadFile(splashHtmlPath);

  splashWindow.webContents.once('did-finish-load', () => {
    splashRendererReady = true;
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('splash-update', latestSplashState);
    }
  });

  // Show window when ready
  splashWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashWindow.show();
    }
  });

  // Handle window closed
  splashWindow.on('closed', () => {
    splashRendererReady = false;
    splashWindow = null;
  });

  return splashWindow;
}

/**
 * Show the splash screen
 * @returns {BrowserWindow} The splash window instance
 */
function showSplash() {
  latestSplashState = {
    progress: 0,
    message: 'Initializing...',
  };
  return createSplashWindow();
}

/**
 * Update the loading progress and status message
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} message - Status message to display
 */
function updateProgress(progress, message) {
  const normalizedProgress = Math.min(Math.max(Number(progress) || 0, 0), 100);
  latestSplashState = {
    progress: Math.max(latestSplashState.progress, normalizedProgress),
    message: message || latestSplashState.message || '',
  };

  if (splashWindow && !splashWindow.isDestroyed() && splashRendererReady) {
    splashWindow.webContents.send('splash-update', latestSplashState);
  }
}

/**
 * Close the splash screen
 * @returns {Promise<void>}
 */
async function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    updateProgress(100, 'Ready');

    // Fade out effect
    splashWindow.webContents.send('splash-fade-out');

    // Wait for fade animation
    await new Promise((resolve) => setTimeout(resolve, 300));

    splashWindow.close();
    splashWindow = null;
  }
}

/**
 * Wait for server to be ready with timeout
 * @param {Function} checkServerReady - Function that returns true when server is ready
 * @param {Object} options - Options
 * @param {number} [options.timeout=15000] - Timeout in milliseconds
 * @param {Function} [options.onProgress] - Callback for progress updates
 * @returns {Promise<boolean>} True if server ready, false if timeout
 */
async function waitForServer(checkServerReady, options = {}) {
  const timeout = options.timeout || SPLASH_TIMEOUT;
  const onProgress = options.onProgress || (() => {});
  const checkInterval = 100; // Check every 100ms
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min((elapsed / timeout) * 100, 95); // Cap at 95% until ready

      if (checkServerReady()) {
        onProgress(100, 'Ready');
        resolve(true);
        return;
      }

      if (elapsed >= timeout) {
        onProgress(100, 'Timeout');
        resolve(false);
        return;
      }

      // Update progress based on elapsed time
      const remaining = Math.ceil((timeout - elapsed) / 1000);
      onProgress(progress, `Starting... (${remaining}s)`);

      setTimeout(check, checkInterval);
    };

    check();
  });
}

/**
 * Get the splash window instance
 * @returns {BrowserWindow|null}
 */
function getSplashWindow() {
  return splashWindow;
}

/**
 * Check if splash window is visible
 * @returns {boolean}
 */
function isSplashVisible() {
  return splashWindow !== null && !splashWindow.isDestroyed() && splashWindow.isVisible();
}

module.exports = {
  createSplashWindow,
  showSplash,
  updateProgress,
  closeSplash,
  waitForServer,
  getSplashWindow,
  isSplashVisible,
  SPLASH_WIDTH,
  SPLASH_HEIGHT,
  SPLASH_TIMEOUT,
};
