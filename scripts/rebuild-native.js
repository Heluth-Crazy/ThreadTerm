#!/usr/bin/env node
/**
 * Native Module Rebuild Script for Electron
 *
 * This script rebuilds native modules (node-pty, better-sqlite3) for the current
 * Electron version and platform architecture. It uses electron-rebuild to
 * automatically detect the Electron version and compile native modules accordingly.
 *
 * Features:
 * - Automatic Electron version detection
 * - Cross-platform architecture support (x64, arm64)
 * - Module-specific rebuild for faster compilation
 * - Proper error handling and logging
 *
 * @module scripts/rebuild-native
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Native modules that need to be rebuilt for Electron
 * @type {string[]}
 */
const NATIVE_MODULES = ['node-pty', 'better-sqlite3'];

/**
 * Executes a command and returns a promise
 *
 * @param {string} command - The command to execute
 * @param {string[]} args - Command arguments
 * @param {Object} options - Spawn options
 * @returns {Promise<void>} Resolves when command completes successfully
 */
function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start command: ${err.message}`));
    });
  });
}

/**
 * Gets the current platform architecture
 *
 * @returns {string} The current architecture (x64, arm64, etc.)
 */
function getCurrentArch() {
  return process.arch;
}

/**
 * Gets the current platform
 *
 * @returns {string} The current platform (darwin, win32, linux)
 */
function getCurrentPlatform() {
  return process.platform;
}

/**
 * Checks if electron-rebuild is available
 *
 * @returns {Promise<boolean>} True if electron-rebuild is available
 */
async function checkElectronRebuild() {
  const electronRebuildPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron-rebuild');
  const electronRebuildCmd = path.join(__dirname, '..', 'node_modules', '.bin', 'electron-rebuild.cmd');

  try {
    await fs.access(process.platform === 'win32' ? electronRebuildCmd : electronRebuildPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuilds a single native module for Electron
 *
 * @param {string} moduleName - The name of the module to rebuild
 * @returns {Promise<void>}
 */
async function rebuildModule(moduleName) {
  const platform = getCurrentPlatform();
  const arch = getCurrentArch();

  console.log(`\n[rebuild-native] Rebuilding ${moduleName} for Electron...`);
  console.log(`[rebuild-native] Platform: ${platform}, Architecture: ${arch}`);

  const isWindows = platform === 'win32';
  const electronRebuildCmd = isWindows
    ? 'electron-rebuild.cmd'
    : './node_modules/.bin/electron-rebuild';

  const args = [
    '-f',
    '-w', moduleName,
    '-v', '33.4.11', // Electron version from package.json
  ];

  // Add architecture flag for cross-compilation support
  if (arch === 'arm64' && platform === 'darwin') {
    args.push('-a', 'arm64');
  } else if (arch === 'x64') {
    args.push('-a', 'x64');
  }

  await execCommand(electronRebuildCmd, args, {
    cwd: path.join(__dirname, '..'),
  });

  console.log(`[rebuild-native] Successfully rebuilt ${moduleName}`);
}

/**
 * Verifies that a native module was built correctly
 *
 * @param {string} moduleName - The name of the module to verify
 * @returns {Promise<boolean>} True if module is properly built
 */
async function verifyModule(moduleName) {
  const modulePath = path.join(__dirname, '..', 'node_modules', moduleName);
  const buildPath = path.join(modulePath, 'build', 'Release');

  try {
    await fs.access(buildPath);
    const files = await fs.readdir(buildPath);
    const hasNativeFile = files.some((file) =>
      file.endsWith('.node') || file.endsWith('.dll') || file.endsWith('.so') || file.endsWith('.dylib')
    );

    if (hasNativeFile) {
      console.log(`[rebuild-native] Verified ${moduleName}: native binary found`);
      return true;
    } else {
      console.warn(`[rebuild-native] Warning: ${moduleName} build directory exists but no native binary found`);
      return false;
    }
  } catch (err) {
    console.warn(`[rebuild-native] Warning: Could not verify ${moduleName}: ${err.message}`);
    return false;
  }
}

/**
 * Main function to rebuild all native modules
 *
 * @returns {Promise<void>}
 */
async function rebuildNativeModules() {
  console.log('========================================');
  console.log('Electron Native Module Rebuild');
  console.log('========================================');
  console.log(`Platform: ${getCurrentPlatform()}`);
  console.log(`Architecture: ${getCurrentArch()}`);
  console.log(`Modules: ${NATIVE_MODULES.join(', ')}`);
  console.log('========================================\n');

  // Check if electron-rebuild is available
  const hasElectronRebuild = await checkElectronRebuild();
  if (!hasElectronRebuild) {
    console.error('[rebuild-native] Error: electron-rebuild not found. Please run npm install first.');
    process.exit(1);
  }

  const results = {
    success: [],
    failed: [],
  };

  // Rebuild each module
  for (const moduleName of NATIVE_MODULES) {
    try {
      await rebuildModule(moduleName);
      const verified = await verifyModule(moduleName);

      if (verified) {
        results.success.push(moduleName);
      } else {
        results.failed.push(moduleName);
      }
    } catch (err) {
      console.error(`[rebuild-native] Error rebuilding ${moduleName}: ${err.message}`);
      results.failed.push(moduleName);
    }
  }

  // Print summary
  console.log('\n========================================');
  console.log('Rebuild Summary');
  console.log('========================================');
  console.log(`Successful: ${results.success.length} module(s)`);
  results.success.forEach((m) => console.log(`  - ${m}`));

  if (results.failed.length > 0) {
    console.log(`\nFailed: ${results.failed.length} module(s)`);
    results.failed.forEach((m) => console.log(`  - ${m}`));
    console.log('\n[rebuild-native] Some modules failed to rebuild. Check the error messages above.');
    process.exit(1);
  } else {
    console.log('\n[rebuild-native] All native modules rebuilt successfully!');
  }
}

// Run the rebuild
rebuildNativeModules().catch((err) => {
  console.error('[rebuild-native] Fatal error:', err.message);
  process.exit(1);
});
