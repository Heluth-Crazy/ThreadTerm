/**
 * Window State Manager
 * Saves and restores window position, size, and maximized state
 * Uses electron-store for persistence
 */

const Store = require('electron-store');
const { screen } = require('electron');

// Schema for window state
const store = new Store({
  name: 'window-state',
  schema: {
    width: {
      type: 'number',
      default: 1400,
    },
    height: {
      type: 'number',
      default: 900,
    },
    x: {
      type: 'number',
    },
    y: {
      type: 'number',
    },
    isMaximized: {
      type: 'boolean',
      default: false,
    },
    isFullScreen: {
      type: 'boolean',
      default: false,
    },
  },
});

// Default window dimensions
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

/**
 * Get the saved window state
 * Validates that the window will be visible on some display
 * @returns {Object} Window state object
 */
function getWindowState() {
  const state = {
    width: store.get('width', DEFAULT_WIDTH),
    height: store.get('height', DEFAULT_HEIGHT),
    x: store.get('x'),
    y: store.get('y'),
    isMaximized: store.get('isMaximized', false),
    isFullScreen: store.get('isFullScreen', false),
  };

  // Validate window is within some display bounds
  const displays = screen.getAllDisplays();
  const isVisible = displays.some(display => {
    const { bounds } = display;
    // Check if at least part of the window is visible
    return (
      state.x !== undefined &&
      state.y !== undefined &&
      state.x < bounds.x + bounds.width &&
      state.x + state.width > bounds.x &&
      state.y < bounds.y + bounds.height &&
      state.y + state.height > bounds.y
    );
  });

  // If not visible or no position saved, center on primary display
  if (!isVisible || state.x === undefined || state.y === undefined) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    state.x = Math.round((width - state.width) / 2);
    state.y = Math.round((height - state.height) / 2);
  }

  // Ensure minimum dimensions
  state.width = Math.max(state.width, MIN_WIDTH);
  state.height = Math.max(state.height, MIN_HEIGHT);

  return state;
}

/**
 * Save the current window state
 * @param {BrowserWindow} window - The window to save state from
 */
function saveWindowState(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  // Don't save dimensions if maximized or fullscreen
  const isMaximized = window.isMaximized();
  const isFullScreen = window.isFullScreen();

  store.set('isMaximized', isMaximized);
  store.set('isFullScreen', isFullScreen);

  // Only save position and size if not maximized or fullscreen
  if (!isMaximized && !isFullScreen) {
    const bounds = window.getBounds();
    store.set('width', bounds.width);
    store.set('height', bounds.height);
    store.set('x', bounds.x);
    store.set('y', bounds.y);
  }
}

/**
 * Apply saved state to a window
 * @param {BrowserWindow} window - The window to apply state to
 */
function applyWindowState(window) {
  const state = getWindowState();

  // Set initial size and position
  window.setBounds({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
  });

  // Restore maximized state after showing (to avoid visual glitches)
  window.once('ready-to-show', () => {
    if (state.isFullScreen) {
      window.setFullScreen(true);
    } else if (state.isMaximized) {
      window.maximize();
    }
  });
}

/**
 * Reset window state to defaults
 * Useful for "Reset Window Position" menu item
 */
function resetWindowState() {
  store.clear();
}

/**
 * Get the store instance for testing/debugging
 * @returns {Store} The electron-store instance
 */
function getStore() {
  return store;
}

module.exports = {
  getWindowState,
  saveWindowState,
  applyWindowState,
  resetWindowState,
  getStore,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
};
