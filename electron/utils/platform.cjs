/**
 * Platform Detection Utilities
 * Cross-platform helper functions for Electron main process
 */

const os = require('os');

/**
 * Check if running on macOS
 * @returns {boolean}
 */
function isMac() {
  return process.platform === 'darwin';
}

/**
 * Check if running on Windows
 * @returns {boolean}
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * Check if running on Linux
 * @returns {boolean}
 */
function isLinux() {
  return process.platform === 'linux';
}

/**
 * Get platform-specific home directory
 * @returns {string}
 */
function getHomeDir() {
  return os.homedir();
}

/**
 * Get platform-specific app data directory name
 * @returns {string}
 */
function getAppDataDirName() {
  return 'OpenWork Desktop';
}

/**
 * Get the default shell for the current platform
 * @returns {string}
 */
function getDefaultShell() {
  if (isMac() || isLinux()) {
    return process.env.SHELL || '/bin/bash';
  }
  if (isWindows()) {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return '/bin/sh';
}

/**
 * Get platform-specific CLI search paths
 * @returns {string[]}
 */
function getCliSearchPaths() {
  const homeDir = getHomeDir();

  if (isMac()) {
    return [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      `${homeDir}/.local/bin`,
      `${homeDir}/bin`,
    ];
  }

  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || `${homeDir}\\AppData\\Local`;
    const appData = process.env.APPDATA || `${homeDir}\\AppData\\Roaming`;
    return [
      `${localAppData}\\Programs\\cursor\\resources\\app\\bin`,
      `${appData}\\npm`,
      `${localAppData}\\Programs\\Python`,
    ];
  }

  if (isLinux()) {
    return [
      '/usr/local/bin',
      '/usr/bin',
      `${homeDir}/.local/bin`,
      `${homeDir}/bin`,
    ];
  }

  return [];
}

/**
 * Path separator constants
 */
const SEPARATOR = {
  POSIX: '/',
  WIN32: '\\',
};

/**
 * Extended CLI search paths for cross-platform CLI discovery
 * Includes additional paths for npm, nvm, and other common installation locations
 * @returns {string[]}
 */
function getExtendedCliSearchPaths() {
  const homeDir = getHomeDir();

  if (isMac()) {
    return [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      `${homeDir}/.local/bin`,
      `${homeDir}/bin`,
      '/opt/local/bin', // MacPorts
      `${homeDir}/.npm-global/bin`, // npm global
      `${homeDir}/.nvm/versions/node/*/bin`, // nvm
    ];
  }

  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || `${homeDir}\\AppData\\Local`;
    const appData = process.env.APPDATA || `${homeDir}\\AppData\\Roaming`;
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

    return [
      `${localAppData}\\Programs\\cursor\\resources\\app\\bin`,
      `${appData}\\npm`,
      `${localAppData}\\Programs\\Python`,
      `${localAppData}\\Microsoft\\WindowsApps`,
      `${programFiles}\\cursor\\resources\\app\\bin`,
      `${programFilesX86}\\cursor\\resources\\app\\bin`,
      `${homeDir}\\.npm-global`,
      `${appData}\\npm-cache`,
    ];
  }

  if (isLinux()) {
    return [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/snap/bin',
      `${homeDir}/.local/bin`,
      `${homeDir}/bin`,
      `${homeDir}/.npm-global/bin`,
      `${homeDir}/.nvm/versions/node/*/bin`,
      '/opt/bin',
    ];
  }

  return [];
}

/**
 * Normalize a path to use forward slashes (neutral format)
 * @param {string} filepath
 * @returns {string}
 */
function normalizePath(filepath) {
  if (!filepath) return '';
  // Replace all backslashes with forward slashes
  return filepath.replace(/\\/g, SEPARATOR.POSIX);
}

/**
 * Convert a path to the current platform's format
 * @param {string} filepath
 * @returns {string}
 */
function toPlatformPath(filepath) {
  if (!filepath) return '';
  if (isWindows()) {
    // On Windows, convert forward slashes to backslashes
    return filepath.replace(/\//g, SEPARATOR.WIN32);
  }
  // On macOS/Linux, ensure forward slashes
  return normalizePath(filepath);
}

/**
 * Join path segments using the appropriate separator
 * @param {...string} segments
 * @returns {string}
 */
function joinPath(...segments) {
  const separator = isWindows() ? SEPARATOR.WIN32 : SEPARATOR.POSIX;
  return segments
    .filter(Boolean)
    .map((seg, index) => {
      // Remove leading/trailing separators except for absolute paths
      let cleaned = seg.replace(/^[\\/]+|[\\/]+$/g, '');
      // Keep leading separator for absolute paths on first segment
      if (index === 0 && (seg.startsWith('/') || seg.startsWith('\\'))) {
        cleaned = separator + cleaned;
      }
      return cleaned;
    })
    .join(separator);
}

/**
 * Get the directory name from a path
 * @param {string} filepath
 * @returns {string}
 */
function getDirName(filepath) {
  if (!filepath) return '';
  const normalized = normalizePath(filepath);
  const lastSep = normalized.lastIndexOf(SEPARATOR.POSIX);
  if (lastSep === -1) return '';
  if (lastSep === 0) return SEPARATOR.POSIX;
  return normalized.substring(0, lastSep);
}

/**
 * Get the base name from a path
 * @param {string} filepath
 * @param {string} [ext] - Optional extension to remove
 * @returns {string}
 */
function getBaseName(filepath, ext) {
  if (!filepath) return '';
  const normalized = normalizePath(filepath);
  const lastSep = normalized.lastIndexOf(SEPARATOR.POSIX);
  const base = lastSep === -1 ? normalized : normalized.substring(lastSep + 1);
  if (ext && base.endsWith(ext)) {
    return base.substring(0, base.length - ext.length);
  }
  return base;
}

/**
 * Get file extension from a path
 * @param {string} filepath
 * @returns {string}
 */
function getExtension(filepath) {
  if (!filepath) return '';
  const base = getBaseName(filepath);
  const lastDot = base.lastIndexOf('.');
  return lastDot === -1 ? '' : base.substring(lastDot);
}

/**
 * Check if a path is absolute
 * @param {string} filepath
 * @returns {boolean}
 */
function isAbsolutePath(filepath) {
  if (!filepath) return false;
  if (isWindows()) {
    // Windows absolute: C:\ or \\server\share
    return /^[a-zA-Z]:[\\/]/.test(filepath) || /^\\\\[^\\]+/.test(filepath);
  }
  // Unix absolute: starts with /
  return filepath.startsWith('/');
}

/**
 * Resolve a relative path against a base path
 * @param {string} from - Base path
 * @param {string} to - Relative path
 * @returns {string}
 */
function resolvePath(from, to) {
  if (!from) return normalizePath(to);
  if (!to) return normalizePath(from);
  if (isAbsolutePath(to)) {
    return normalizePath(to);
  }

  const separator = isWindows() ? SEPARATOR.WIN32 : SEPARATOR.POSIX;
  const base = normalizePath(from);
  const relative = normalizePath(to);

  // Track if base is absolute (starts with /)
  const isBaseAbsolute = base.startsWith(SEPARATOR.POSIX);

  // Handle Windows drive letters
  let drivePrefix = '';
  if (isWindows() && /^[a-zA-Z]:/i.test(base)) {
    drivePrefix = base.substring(0, 2);
  }

  const baseParts = base.split(SEPARATOR.POSIX).filter(Boolean);
  const relativeParts = relative.split(SEPARATOR.POSIX).filter(Boolean);

  // Remove the file name from base if it's a file path
  const lastBasePart = baseParts[baseParts.length - 1];
  if (lastBasePart && lastBasePart.includes('.')) {
    baseParts.pop();
  }

  for (const part of relativeParts) {
    if (part === '..') {
      baseParts.pop();
    } else if (part !== '.') {
      baseParts.push(part);
    }
  }

  const result = baseParts.join(separator);
  const prefix = drivePrefix ? drivePrefix + separator : (isBaseAbsolute ? separator : '');
  return prefix + result;
}

/**
 * Convert a path for database storage (always use forward slashes)
 * @param {string} filepath
 * @returns {string}
 */
function toDbPath(filepath) {
  return normalizePath(filepath);
}

/**
 * Convert a database path to platform-specific format
 * @param {string} dbPath
 * @returns {string}
 */
function fromDbPath(dbPath) {
  return toPlatformPath(dbPath);
}

module.exports = {
  isMac,
  isWindows,
  isLinux,
  getHomeDir,
  getAppDataDirName,
  getDefaultShell,
  getCliSearchPaths,
  getExtendedCliSearchPaths,
  normalizePath,
  toPlatformPath,
  joinPath,
  getDirName,
  getBaseName,
  getExtension,
  isAbsolutePath,
  resolvePath,
  toDbPath,
  fromDbPath,
};
