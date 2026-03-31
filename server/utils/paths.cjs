/**
 * Cross-platform Path Utilities
 * Server-side path handling for consistent database storage
 */

const path = require('path');

/**
 * Path separator constants
 */
const SEPARATOR = {
  POSIX: '/',
  WIN32: '\\',
};

/**
 * Check if running on Windows
 * @returns {boolean}
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * Normalize a path to use forward slashes (neutral format for database)
 * @param {string} filepath
 * @returns {string}
 */
function normalizePath(filepath) {
  if (!filepath) return '';
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
    return filepath.replace(/\//g, SEPARATOR.WIN32);
  }
  return normalizePath(filepath);
}

/**
 * Join path segments using the appropriate separator
 * @param {...string} segments
 * @returns {string}
 */
function joinPath(...segments) {
  const joined = path.join(...segments);
  return normalizePath(joined);
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
    return /^[a-zA-Z]:[\\/]/.test(filepath) || /^\\\\[^\\]+/.test(filepath);
  }
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
  const resolved = path.resolve(from, to);
  return normalizePath(resolved);
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

/**
 * Get relative path from one path to another
 * @param {string} from - Source path
 * @param {string} to - Target path
 * @returns {string}
 */
function getRelativePath(from, to) {
  const relative = path.relative(from, to);
  return normalizePath(relative);
}

module.exports = {
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
  getRelativePath,
};
