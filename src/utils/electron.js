/**
 * Electron IPC Utility
 * Frontend wrapper for electronAPI exposed via preload script
 */

// Check if running in Electron environment
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

/**
 * Platform utilities
 */
export const platform = {
  getInfo: () => {
    if (!isElectron()) return null;
    return window.electronAPI.platform;
  },

  isMac: () => {
    if (!isElectron()) return false;
    return window.electronAPI.platform.isMac;
  },

  isWindows: () => {
    if (!isElectron()) return false;
    return window.electronAPI.platform.isWindows;
  },

  isLinux: () => {
    if (!isElectron()) return false;
    return window.electronAPI.platform.isLinux;
  },
};

/**
 * App information
 */
export const app = {
  getVersion: () => {
    if (!isElectron()) return null;
    return window.electronAPI.app.version;
  },

  isDev: () => {
    if (!isElectron()) return false;
    return window.electronAPI.app.isDev;
  },
};

/**
 * File dialog utilities
 */
export const fileDialog = {
  /**
   * Show open file/folder dialog
   * @param {Object} options - Dialog options
   * @param {string} options.title - Dialog title
   * @param {string} options.defaultPath - Default path
   * @param {string} options.buttonLabel - Custom button label
   * @param {Array} options.filters - File filters
   * @param {boolean} options.properties - Dialog properties (openFile, openDirectory, multiSelections, etc.)
   * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
   */
  showOpenDialog: async (options = {}) => {
    if (!isElectron()) {
      throw new Error('File dialog is only available in Electron environment');
    }
    return window.electronAPI.showOpenDialog(options);
  },

  /**
   * Show save file dialog
   * @param {Object} options - Dialog options
   * @param {string} options.title - Dialog title
   * @param {string} options.defaultPath - Default path
   * @param {string} options.buttonLabel - Custom button label
   * @param {Array} options.filters - File filters
   * @returns {Promise<{canceled: boolean, filePath: string}>}
   */
  showSaveDialog: async (options = {}) => {
    if (!isElectron()) {
      throw new Error('File dialog is only available in Electron environment');
    }
    return window.electronAPI.showSaveDialog(options);
  },

  /**
   * Select a directory
   * @param {Object} options - Additional options
   * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
   */
  selectDirectory: async (options = {}) => {
    return fileDialog.showOpenDialog({
      title: 'Select Directory',
      properties: ['openDirectory'],
      ...options,
    });
  },

  /**
   * Select a file
   * @param {Array} filters - File filters
   * @param {Object} options - Additional options
   * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
   */
  selectFile: async (filters = [], options = {}) => {
    return fileDialog.showOpenDialog({
      title: 'Select File',
      properties: ['openFile'],
      filters,
      ...options,
    });
  },

  /**
   * Select multiple files
   * @param {Array} filters - File filters
   * @param {Object} options - Additional options
   * @returns {Promise<{canceled: boolean, filePaths: string[]}>}
   */
  selectFiles: async (filters = [], options = {}) => {
    return fileDialog.showOpenDialog({
      title: 'Select Files',
      properties: ['openFile', 'multiSelections'],
      filters,
      ...options,
    });
  },
};

/**
 * Window control utilities
 */
export const windowControl = {
  minimize: () => {
    if (!isElectron()) return;
    window.electronAPI.windowControl.minimize();
  },

  maximize: () => {
    if (!isElectron()) return;
    window.electronAPI.windowControl.maximize();
  },

  unmaximize: () => {
    if (!isElectron()) return;
    window.electronAPI.windowControl.unmaximize();
  },

  close: () => {
    if (!isElectron()) return;
    window.electronAPI.windowControl.close();
  },

  isMaximized: async () => {
    if (!isElectron()) return false;
    return window.electronAPI.windowControl.isMaximized();
  },

  toggleMaximize: () => {
    if (!isElectron()) return;
    window.electronAPI.windowControl.toggleMaximize();
  },

  /**
   * Subscribe to window focus changes
   * @param {Function} callback - Callback function(isFocused)
   * @returns {Function} Unsubscribe function
   */
  onFocusChange: (callback) => {
    if (!isElectron()) return () => {};
    window.electronAPI.onWindowFocus(callback);
    return () => {
      window.electronAPI.removeAllListeners('window-focus');
    };
  },
};

/**
 * Notification utilities
 */
export const notification = {
  /**
   * Show a native notification
   * @param {Object} options - Notification options
   * @param {string} options.title - Notification title
   * @param {string} options.body - Notification body
   * @param {string} options.icon - Icon path
   * @param {boolean} options.silent - Whether to play sound
   */
  show: (options) => {
    if (!isElectron()) {
      // Fallback to web notification
      if ('Notification' in window) {
        new Notification(options.title, {
          body: options.body,
          icon: options.icon,
        });
      }
      return;
    }
    window.electronAPI.notification.show(options);
  },

  /**
   * Request notification permission
   * @returns {Promise<string>} Permission status
   */
  requestPermission: async () => {
    if (!isElectron()) {
      if ('Notification' in window) {
        return Notification.requestPermission();
      }
      return 'denied';
    }
    return window.electronAPI.notification.requestPermission();
  },

  /**
   * Show a success notification
   * @param {string} message - Notification message
   * @param {string} title - Notification title
   */
  success: (message, title = 'Success') => {
    notification.show({
      title,
      body: message,
    });
  },

  /**
   * Show an error notification
   * @param {string} message - Notification message
   * @param {string} title - Notification title
   */
  error: (message, title = 'Error') => {
    notification.show({
      title,
      body: message,
    });
  },

  /**
   * Show an info notification
   * @param {string} message - Notification message
   * @param {string} title - Notification title
   */
  info: (message, title = 'Information') => {
    notification.show({
      title,
      body: message,
    });
  },
};

/**
 * Theme utilities
 */
export const theme = {
  /**
   * Get current theme
   * @returns {Promise<'dark' | 'light'>}
   */
  getCurrent: async () => {
    if (!isElectron()) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return window.electronAPI.theme.getCurrentTheme();
  },

  /**
   * Subscribe to theme changes
   * @param {Function} callback - Callback function(theme)
   * @returns {Function} Unsubscribe function
   */
  onChange: (callback) => {
    if (!isElectron()) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e) => callback(e.matches ? 'dark' : 'light');
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
    window.electronAPI.theme.onThemeChanged(callback);
    return () => {
      window.electronAPI.removeAllListeners('theme-changed');
    };
  },
};

/**
 * App control utilities
 */
export const appControl = {
  /**
   * Quit the application
   */
  quit: () => {
    if (!isElectron()) return;
    window.electronAPI.appControl.quit();
  },

  /**
   * Relaunch the application
   */
  relaunch: () => {
    if (!isElectron()) return;
    window.electronAPI.appControl.relaunch();
  },

  /**
   * Get a system path
   * @param {string} name - Path name (home, appData, userData, temp, etc.)
   * @returns {Promise<string | null>}
   */
  getPath: async (name) => {
    if (!isElectron()) return null;
    return window.electronAPI.appControl.getPath(name);
  },

  /**
   * Get user data path
   * @returns {Promise<string | null>}
   */
  getUserDataPath: async () => {
    return appControl.getPath('userData');
  },

  /**
   * Get downloads path
   * @returns {Promise<string | null>}
   */
  getDownloadsPath: async () => {
    return appControl.getPath('downloads');
  },

  /**
   * Get documents path
   * @returns {Promise<string | null>}
   */
  getDocumentsPath: async () => {
    return appControl.getPath('documents');
  },
};

/**
 * Remove all listeners for a specific channel
 * @param {string} channel - Channel name
 */
export const removeAllListeners = (channel) => {
  if (!isElectron()) return;
  window.electronAPI.removeAllListeners(channel);
};

/**
 * Check if running in Electron environment
 */
export const checkElectron = isElectron;

// Default export with all utilities
export default {
  platform,
  app,
  fileDialog,
  windowControl,
  notification,
  theme,
  appControl,
  removeAllListeners,
  isElectron,
};
