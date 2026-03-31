/**
 * Embedded Backend Server Manager
 * OpenWork Desktop - Server Management Module
 *
 * Features:
 * - Dynamic port allocation (starting from 3001)
 * - Graceful server startup and shutdown
 * - Port conflict handling with automatic fallback
 * - Integration with Electron's app lifecycle
 */

const { app } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Server state
let serverInstance = null;
let serverPort = null;
let isStarting = false;
let startPromise = null;
let backendModule = null;

// Configuration
const DEFAULT_START_PORT = 3001;
const MAX_PORT_ATTEMPTS = 20;

/**
 * Get the server data directory
 * Uses app.getPath('userData') for cross-platform consistency
 * @returns {string} Path to server data directory
 */
function getServerDataDir() {
  const userDataPath = app.getPath('userData');
  const dataDir = path.join(userDataPath, 'server-data');

  // Ensure directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
}

/**
 * Check if a port is available
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is available
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = http.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port starting from the given port
 * @param {number} startPort - Port to start checking from
 * @returns {Promise<number>} Available port number
 */
async function findAvailablePort(startPort = DEFAULT_START_PORT) {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = startPort + i;
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
    console.log(`[Server] Port ${port} is in use, trying next...`);
  }
  throw new Error(`Could not find an available port after ${MAX_PORT_ATTEMPTS} attempts`);
}

/**
 * Get the logs directory path
 * Uses app.getPath('userData') for cross-platform consistency
 * @returns {string} Path to logs directory
 */
function getLogsDir() {
  const userDataPath = app.getPath('userData');
  const logsDir = path.join(userDataPath, 'logs');

  // Ensure directory exists
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  return logsDir;
}

/**
 * Import and configure the backend server
 * This dynamically imports the ES module server/index.js
 * @returns {Promise<{app: Express, server: HttpServer, startServer: Function}>}
 */
async function importBackendServer() {
  // Set environment variables before importing server
  const dataDir = getServerDataDir();
  const logsDir = getLogsDir();

  // Configure data directories
  process.env.SERVER_DATA_DIR = dataDir;
  process.env.LOGS_DIR = logsDir;

  // Configure database path to use userData directory
  // This ensures SQLite database is stored in the platform-standard location:
  // - macOS: ~/Library/Application Support/OpenWork Desktop/server-data/auth.db
  // - Windows: %APPDATA%/OpenWork Desktop/server-data/auth.db
  const dbPath = path.join(dataDir, 'auth.db');
  process.env.DATABASE_PATH = dbPath;

  console.log('[Server] Data directory:', dataDir);
  console.log('[Server] Logs directory:', logsDir);
  console.log('[Server] Database path:', dbPath);

  // Dynamic import of the ES module server
  // In dev mode, app.getAppPath() returns electron directory, so we need to go up two levels
  const serverPath = path.join(__dirname, '..', '..', 'server', 'index.js');
  const serverPathUrl = pathToFileURL(serverPath).href;

  // Import the server module
  const serverModule = await import(serverPathUrl);

  return serverModule;
}

/**
 * Start the embedded backend server
 * @param {Object} options - Start options
 * @param {number} [options.startPort=3001] - Port to start from
 * @param {Function} [options.onReady] - Callback when server is ready
 * @returns {Promise<{port: number, url: string}>} Server info
 */
async function startServer(options = {}) {
  // Prevent concurrent start attempts
  if (isStarting) {
    return startPromise;
  }

  if (serverInstance) {
    console.log('[Server] Server already running on port:', serverPort);
    return { port: serverPort, url: `http://localhost:${serverPort}` };
  }

  isStarting = true;
  startPromise = (async () => {
    try {
      const startPort = options.startPort || DEFAULT_START_PORT;

      console.log('[Server] Finding available port...');
      const port = await findAvailablePort(startPort);
      console.log(`[Server] Found available port: ${port}`);

      // Set the port for the server to use
      process.env.PORT = port.toString();
      process.env.HOST = '127.0.0.1';

      console.log('[Server] Importing backend server...');
      const backend = await importBackendServer();
      backendModule = backend;

      // Call startServer() to start the backend server
      // Note: startServer() is exported from server/index.js but uses callbacks, not promises
      console.log('[Server] Calling backend startServer()...');
      if (backend.startServer && typeof backend.startServer === 'function') {
        // startServer uses callbacks internally, so we call it and then poll for readiness
        backend.startServer();
      }

      // Wait for the server to actually start accepting connections
      console.log('[Server] Waiting for server to start...');
      const maxAttempts = 30;
      const retryDelay = 500;
      let serverReady = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));

        try {
          const checkServer = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/health',
            method: 'GET'
          }, (res) => {
            if (res.statusCode === 200) {
              serverReady = true;
            }
          });

          await new Promise((resolve) => {
            checkServer.on('close', resolve);
            checkServer.on('error', resolve);
            checkServer.end();
          });

          if (serverReady) {
            console.log('[Server] Server is ready!');
            break;
          }
        } catch (e) {
          // Server not ready yet, continue waiting
        }

        console.log(`[Server] Waiting for server... (attempt ${attempt + 1}/${maxAttempts})`);
      }

      if (!serverReady) {
        throw new Error(`Server failed to start after ${maxAttempts * retryDelay}ms`);
      }

      serverPort = port;
      serverInstance = backend.server || { listening: true };

      const url = `http://localhost:${port}`;
      console.log(`[Server] Server started successfully at ${url}`);

      if (options.onReady) {
        options.onReady({ port, url });
      }

      return { port, url };
    } catch (error) {
      console.error('[Server] Failed to start server:', error);
      throw error;
    } finally {
      isStarting = false;
      startPromise = null;
    }
  })();

  return startPromise;
}

/**
 * Stop the embedded backend server
 * @param {Object} options - Stop options
 * @param {number} [options.timeout=5000] - Timeout for graceful shutdown
 * @returns {Promise<boolean>} True if stopped successfully
 */
async function stopServer(options = {}) {
  const timeout = options.timeout || 5000;

  if (!serverInstance && !backendModule) {
    console.log('[Server] No server instance to stop');
    return true;
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log('[Server] Server stop timed out, forcing close');
      serverInstance = null;
      serverPort = null;
      backendModule = null;
      resolve(false);
    }, timeout);

    try {
      if (backendModule && typeof backendModule.shutdownServerResources === 'function') {
        backendModule.shutdownServerResources({ timeout })
          .then((stopped) => {
            clearTimeout(timeoutId);
            console.log('[Server] Backend resources stopped:', stopped);
            serverInstance = null;
            serverPort = null;
            backendModule = null;
            resolve(Boolean(stopped));
          })
          .catch((shutdownError) => {
            console.error('[Server] Error in backend shutdown handler:', shutdownError);

            if (serverInstance && serverInstance.close) {
              serverInstance.close(() => {
                clearTimeout(timeoutId);
                serverInstance = null;
                serverPort = null;
                backendModule = null;
                resolve(false);
              });
            } else {
              clearTimeout(timeoutId);
              serverInstance = null;
              serverPort = null;
              backendModule = null;
              resolve(false);
            }
          });
        return;
      }

      // Close the HTTP server
      if (serverInstance.close) {
        serverInstance.close(() => {
          clearTimeout(timeoutId);
          console.log('[Server] Server stopped gracefully');
          serverInstance = null;
          serverPort = null;
          backendModule = null;
          resolve(true);
        });
      } else {
        clearTimeout(timeoutId);
        serverInstance = null;
        serverPort = null;
        backendModule = null;
        resolve(true);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      console.error('[Server] Error stopping server:', error);
      serverInstance = null;
      serverPort = null;
      backendModule = null;
      resolve(false);
    }
  });
}

/**
 * Get the current server status
 * @returns {{running: boolean, port: number|null, url: string|null}}
 */
function getServerStatus() {
  const running = serverInstance !== null;
  return {
    running,
    port: serverPort,
    url: running ? `http://localhost:${serverPort}` : null
  };
}

/**
 * Get the server port (convenience function)
 * @returns {number|null} The server port or null if not running
 */
function getServerPort() {
  return serverPort;
}

/**
 * Get the server URL (convenience function)
 * @returns {string|null} The server URL or null if not running
 */
function getServerUrl() {
  return serverPort ? `http://localhost:${serverPort}` : null;
}

module.exports = {
  startServer,
  stopServer,
  getServerStatus,
  getServerPort,
  getServerUrl,
  getServerDataDir,
  getLogsDir,
  findAvailablePort,
  isPortAvailable
};
