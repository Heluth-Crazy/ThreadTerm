/**
 * Native Application Menu
 * Platform-specific menu templates for macOS and Windows
 *
 * Features:
 * - macOS: App menu with About, Quit
 * - Windows: Standard menu without App menu
 * - Common keyboard shortcuts (New, Open, Reload, DevTools, Quit)
 */

const { app, Menu, shell, BrowserWindow } = require('electron');
const { isMac, isWindows } = require('./platform.cjs');

/**
 * Get the focused window or null
 * @returns {BrowserWindow|null}
 */
function getFocusedWindow() {
  return BrowserWindow.getFocusedWindow();
}

/**
 * Send action to renderer process
 * @param {string} action - Action name
 * @param {*} data - Optional data
 */
function sendToRenderer(action, data) {
  const win = getFocusedWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('menu-action', { action, data });
  }
}

/**
 * Create macOS App Menu (first menu item)
 * @returns {Object}
 */
function createMacAppMenu() {
  return {
    label: app.getName(),
    submenu: [
      {
        label: `About ${app.getName()}`,
        selector: 'orderFrontStandardAboutPanel:',
      },
      { type: 'separator' },
      {
        label: 'Preferences...',
        accelerator: 'Cmd+,',
        click: () => sendToRenderer('preferences'),
      },
      { type: 'separator' },
      {
        label: 'Services',
        role: 'services',
        submenu: [],
      },
      { type: 'separator' },
      {
        label: `Hide ${app.getName()}`,
        accelerator: 'Cmd+H',
        role: 'hide',
      },
      {
        label: 'Hide Others',
        accelerator: 'Cmd+Alt+H',
        role: 'hideothers',
      },
      {
        label: 'Show All',
        role: 'unhide',
      },
      { type: 'separator' },
      {
        label: `Quit ${app.getName()}`,
        accelerator: 'Cmd+Q',
        click: () => app.quit(),
      },
    ],
  };
}

/**
 * Create File Menu
 * @returns {Object}
 */
function createFileMenu() {
  const fileMenu = {
    label: 'File',
    submenu: [
      {
        label: 'New Project',
        accelerator: 'CmdOrCtrl+N',
        click: () => sendToRenderer('new-project'),
      },
      {
        label: 'Open...',
        accelerator: 'CmdOrCtrl+O',
        click: () => sendToRenderer('open-project'),
      },
      { type: 'separator' },
      {
        label: 'Close Window',
        accelerator: 'CmdOrCtrl+W',
        role: 'close',
      },
    ],
  };

  // Add Quit option for Windows (macOS has it in App menu)
  if (isWindows()) {
    fileMenu.submenu.push(
      { type: 'separator' },
      {
        label: 'Exit',
        accelerator: 'Ctrl+Q',
        click: () => app.quit(),
      }
    );
  }

  return fileMenu;
}

/**
 * Create Edit Menu
 * @returns {Object}
 */
function createEditMenu() {
  return {
    label: 'Edit',
    submenu: [
      {
        label: 'Undo',
        accelerator: 'CmdOrCtrl+Z',
        role: 'undo',
      },
      {
        label: 'Redo',
        accelerator: isMac() ? 'Cmd+Shift+Z' : 'Ctrl+Y',
        role: 'redo',
      },
      { type: 'separator' },
      {
        label: 'Cut',
        accelerator: 'CmdOrCtrl+X',
        role: 'cut',
      },
      {
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        role: 'copy',
      },
      {
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        role: 'paste',
      },
      {
        label: 'Select All',
        accelerator: 'CmdOrCtrl+A',
        role: 'selectall',
      },
    ],
  };
}

/**
 * Create View Menu
 * @returns {Object}
 */
function createViewMenu() {
  return {
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: (item, focusedWindow) => {
          if (focusedWindow) {
            focusedWindow.reload();
          }
        },
      },
      {
        label: 'Force Reload',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: (item, focusedWindow) => {
          if (focusedWindow) {
            focusedWindow.webContents.reloadIgnoringCache();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'F12',
        click: (item, focusedWindow) => {
          if (focusedWindow) {
            focusedWindow.webContents.toggleDevTools();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Actual Size',
        accelerator: 'CmdOrCtrl+0',
        role: 'resetzoom',
      },
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+Plus',
        role: 'zoomin',
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        role: 'zoomout',
      },
      { type: 'separator' },
      {
        label: 'Toggle Full Screen',
        accelerator: isMac() ? 'Ctrl+Cmd+F' : 'F11',
        role: 'togglefullscreen',
      },
    ],
  };
}

/**
 * Create Window Menu
 * @returns {Object}
 */
function createWindowMenu() {
  const windowMenu = {
    label: 'Window',
    role: 'window',
    submenu: [
      {
        label: 'Minimize',
        accelerator: 'CmdOrCtrl+M',
        role: 'minimize',
      },
      {
        label: 'Zoom',
        role: 'zoom',
      },
      { type: 'separator' },
      {
        label: 'Close',
        accelerator: 'CmdOrCtrl+W',
        role: 'close',
      },
    ],
  };

  // macOS specific window menu items
  if (isMac()) {
    windowMenu.submenu.push(
      { type: 'separator' },
      {
        label: 'Bring All to Front',
        role: 'front',
      }
    );
  }

  return windowMenu;
}

/**
 * Create Help Menu
 * @returns {Object}
 */
function createHelpMenu() {
  const helpMenu = {
    label: 'Help',
    role: 'help',
    submenu: [
      {
        label: 'Documentation',
        click: () => {
          shell.openExternal('https://openwork.ai/docs');
        },
      },
      {
        label: 'Keyboard Shortcuts',
        accelerator: 'CmdOrCtrl+/',
        click: () => sendToRenderer('keyboard-shortcuts'),
      },
      { type: 'separator' },
      {
        label: 'Check for Updates',
        click: () => sendToRenderer('check-for-updates'),
      },
      { type: 'separator' },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'F12',
        click: (item, focusedWindow) => {
          if (focusedWindow) {
            focusedWindow.webContents.toggleDevTools();
          }
        },
      },
    ],
  };

  return helpMenu;
}

/**
 * Create the complete menu template based on platform
 * @returns {Array}
 */
function createMenuTemplate() {
  const template = [];

  // macOS: Add App menu as the first item
  if (isMac()) {
    template.push(createMacAppMenu());
  }

  // Common menus
  template.push(createFileMenu());
  template.push(createEditMenu());
  template.push(createViewMenu());
  template.push(createWindowMenu());
  template.push(createHelpMenu());

  return template;
}

/**
 * Build and set the application menu
 */
function setApplicationMenu() {
  const template = createMenuTemplate();
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Get menu for a specific window (for context menus)
 * @returns {Menu|null}
 */
function getContextMenu() {
  const template = [
    {
      label: 'Cut',
      role: 'cut',
    },
    {
      label: 'Copy',
      role: 'copy',
    },
    {
      label: 'Paste',
      role: 'paste',
    },
    { type: 'separator' },
    {
      label: 'Select All',
      role: 'selectall',
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = {
  setApplicationMenu,
  getContextMenu,
  createMenuTemplate,
};
