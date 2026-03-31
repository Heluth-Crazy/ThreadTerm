/**
 * Electron Preload Script
 * Secure context bridge for IPC communication between main and renderer
 */

const { contextBridge, ipcRenderer } = require('electron');
const log = require('electron-log');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform information
  platform: {
    isMac: process.platform === 'darwin',
    isWindows: process.platform === 'win32',
    isLinux: process.platform === 'linux',
    platform: process.platform,
    arch: process.arch,
    version: process.version,
  },

  // App information
  app: {
    version: process.env.npm_package_version || '1.0.0',
    isDev: process.env.NODE_ENV === 'development',
  },

  // Window events
  onWindowFocus: (callback) => {
    ipcRenderer.on('window-focus', (event, isFocused) => callback(isFocused));
  },

  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // App lifecycle events
  onBeforeQuit: (callback) => {
    ipcRenderer.on('app-before-quit', () => callback());
  },

  // File Dialog APIs
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // Window Control APIs
  windowControl: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    unmaximize: () => ipcRenderer.send('window-unmaximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    toggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
    setFullScreen: (flag) => ipcRenderer.send('window-set-fullscreen', flag),
    isFullScreen: () => ipcRenderer.invoke('window-is-fullscreen'),
    toggleFullScreen: () => ipcRenderer.send('window-toggle-fullscreen'),
  },

  // Notification API
  notification: {
    show: (options) => ipcRenderer.send('show-notification', options),
    requestPermission: () => ipcRenderer.invoke('request-notification-permission'),
  },

  // Theme API
  theme: {
    onThemeChanged: (callback) => {
      ipcRenderer.on('theme-changed', (event, theme) => callback(theme));
    },
    getCurrentTheme: () => ipcRenderer.invoke('get-current-theme'),
  },

  // App Control API
  appControl: {
    quit: () => ipcRenderer.send('app-quit'),
    relaunch: () => ipcRenderer.send('app-relaunch'),
    getPath: (name) => ipcRenderer.invoke('app-get-path', name),
  },

  // Splash screen API
  splash: {
    onUpdate: (callback) => {
      ipcRenderer.on('splash-update', (event, data) => callback(data));
    },
    onFadeOut: (callback) => {
      ipcRenderer.on('splash-fade-out', () => callback());
    },
  },

  // Get app version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAppIconDataUrl: () => ipcRenderer.invoke('get-app-icon-data-url'),

  // Updater API
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    getStatus: () => ipcRenderer.invoke('get-update-status'),
    onUpdateAvailable: (callback) => {
      ipcRenderer.on('update-available', (event, data) => callback(data));
    },
    onUpdateNotAvailable: (callback) => {
      ipcRenderer.on('update-not-available', (event, data) => callback(data));
    },
    onDownloadProgress: (callback) => {
      ipcRenderer.on('update-download-progress', (event, data) => callback(data));
    },
    onUpdateDownloaded: (callback) => {
      ipcRenderer.on('update-downloaded', (event, data) => callback(data));
    },
    onUpdateError: (callback) => {
      ipcRenderer.on('update-error', (event, data) => callback(data));
    },
  },

  // Logger API - expose safe logging methods to renderer
  log: {
    debug: (...args) => log.debug(...args),
    info: (...args) => log.info(...args),
    warn: (...args) => log.warn(...args),
    error: (...args) => log.error(...args),
  },
});

// Log preload script initialization
log.info('Preload script initialized');
log.info(`Platform: ${process.platform}`);
log.info(`Architecture: ${process.arch}`);
