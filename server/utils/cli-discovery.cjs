/**
 * Cross-platform CLI Discovery Utility
 * Automatically detects CLI paths (Claude Code, Codex) across platforms
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizePath, toPlatformPath, joinPath } = require('./paths.cjs');

// Cache for CLI detection results
const cliCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if running on Windows
 * @returns {boolean}
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * Check if running on macOS
 * @returns {boolean}
 */
function isMac() {
  return process.platform === 'darwin';
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
  return require('os').homedir();
}

/**
 * Get platform-specific CLI search paths
 * These are the paths where CLIs might be installed
 * @returns {string[]}
 */
function getCliSearchPaths() {
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

    return [
      `${appData}\\npm`,
      `${localAppData}\\Programs\\Python`,
      `${localAppData}\\Microsoft\\WindowsApps`,
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
 * Check if a file exists and is executable
 * @param {string} filePath
 * @returns {boolean}
 */
function isExecutable(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;

    // On Windows, check if file has executable extension
    if (isWindows()) {
      const ext = path.extname(filePath).toLowerCase();
      return ['.exe', '.cmd', '.bat', '.ps1'].includes(ext);
    }

    // On Unix, check execute permission
    const mode = stats.mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Use 'which' command (Unix) or 'where' command (Windows) to find CLI
 * @param {string} command - Command name to find
 * @returns {string|null} - Full path to command or null if not found
 */
function findWithSystemCommand(command) {
  try {
    const cmd = isWindows() ? 'where' : 'which';
    const result = execSync(`${cmd} ${command}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    if (result) {
      // On Windows, 'where' may return multiple lines
      const firstPath = result.split('\n')[0].trim();
      if (isExecutable(firstPath)) {
        return firstPath;
      }
    }
  } catch {
    // Command not found via system command
  }
  return null;
}

/**
 * Search for CLI in predefined search paths
 * @param {string} command - Command name to find
 * @returns {string|null} - Full path to command or null if not found
 */
function findInSearchPaths(command) {
  const searchPaths = getCliSearchPaths();
  const extensions = isWindows() ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const searchPath of searchPaths) {
    // Handle glob patterns (e.g., nvm versions)
    if (searchPath.includes('*')) {
      const expandedPaths = expandGlobPath(searchPath);
      for (const expandedPath of expandedPaths) {
        const result = checkPathForCommand(expandedPath, command, extensions);
        if (result) return result;
      }
    } else {
      const result = checkPathForCommand(searchPath, command, extensions);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Check if command exists in a specific directory
 * @param {string} dir - Directory to check
 * @param {string} command - Command name
 * @param {string[]} extensions - File extensions to try (Windows)
 * @returns {string|null}
 */
function checkPathForCommand(dir, command, extensions) {
  for (const ext of extensions) {
    const fullPath = path.join(dir, command + ext);
    if (isExecutable(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Expand glob patterns in paths (simple version for nvm paths)
 * @param {string} globPath - Path with glob pattern
 * @returns {string[]}
 */
function expandGlobPath(globPath) {
  try {
    const basePath = globPath.split('*')[0];
    if (!fs.existsSync(basePath)) return [];

    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    const expanded = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Replace * with the directory name
        const resolved = globPath.replace('*', entry.name);
        expanded.push(resolved);
      }
    }

    return expanded;
  } catch {
    return [];
  }
}

/**
 * Check PATH environment variable for command
 * @param {string} command - Command name
 * @returns {string|null}
 */
function findInPath(command) {
  const pathEnv = process.env.PATH || '';
  const pathSeparator = isWindows() ? ';' : ':';
  const paths = pathEnv.split(pathSeparator);
  const extensions = isWindows() ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of paths) {
    const result = checkPathForCommand(dir.trim(), command, extensions);
    if (result) return result;
  }

  return null;
}

/**
 * Get cache key for a CLI
 * @param {string} cliName
 * @returns {string}
 */
function getCacheKey(cliName) {
  return `cli:${cliName}`;
}

/**
 * Get cached result if valid
 * @param {string} cliName
 * @returns {object|null}
 */
function getCachedResult(cliName) {
  const key = getCacheKey(cliName);
  const cached = cliCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  return null;
}

/**
 * Cache detection result
 * @param {string} cliName
 * @param {object} result
 */
function setCachedResult(cliName, result) {
  const key = getCacheKey(cliName);
  cliCache.set(key, {
    result,
    timestamp: Date.now()
  });
}

/**
 * Clear CLI detection cache
 */
function clearCliCache() {
  cliCache.clear();
}

/**
 * Detect CLI path
 * @param {string} cliName - CLI command name (e.g., 'claude', 'codex')
 * @param {object} options - Detection options
 * @param {boolean} options.skipCache - Skip cache and force re-detection
 * @returns {object} Detection result
 */
function detectCli(cliName, options = {}) {
  const { skipCache = false } = options;

  // Check cache first
  if (!skipCache) {
    const cached = getCachedResult(cliName);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const result = {
    name: cliName,
    found: false,
    path: null,
    version: null,
    error: null
  };

  try {
    // Try system command first (which/where)
    let cliPath = findWithSystemCommand(cliName);

    // Fall back to searching in predefined paths
    if (!cliPath) {
      cliPath = findInSearchPaths(cliName);
    }

    // Last resort: check PATH
    if (!cliPath) {
      cliPath = findInPath(cliName);
    }

    if (cliPath) {
      result.found = true;
      // Normalize path for consistent database storage (F002)
      result.path = normalizePath(cliPath);

      // Try to get version
      try {
        const versionOutput = execSync(`"${cliPath}" --version`, {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        result.version = versionOutput;
      } catch {
        // Version check failed, but CLI was found
        result.version = null;
      }
    } else {
      result.error = `${cliName} not found in system PATH or common installation directories`;
    }
  } catch (error) {
    result.error = error.message;
  }

  // Cache the result
  setCachedResult(cliName, result);

  return result;
}

/**
 * Detect all supported CLIs
 * @param {object} options - Detection options
 * @returns {object} Results for all CLIs
 */
function detectAllClis(options = {}) {
  const clis = ['claude', 'codex'];
  const results = {};

  for (const cli of clis) {
    results[cli] = detectCli(cli, options);
  }

  return results;
}

/**
 * Get CLI discovery status for API response
 * @returns {object} Status object for all CLIs
 */
function getCliDiscoveryStatus() {
  const detections = detectAllClis();

  return {
    success: true,
    clis: detections,
    summary: {
      total: Object.keys(detections).length,
      found: Object.values(detections).filter(d => d.found).length,
      missing: Object.values(detections).filter(d => !d.found).length
    },
    platform: {
      os: process.platform,
      isWindows: isWindows(),
      isMac: isMac(),
      isLinux: isLinux()
    }
  };
}

module.exports = {
  detectCli,
  detectAllClis,
  getCliDiscoveryStatus,
  clearCliCache,
  getCliSearchPaths,
  isWindows,
  isMac,
  isLinux
};
