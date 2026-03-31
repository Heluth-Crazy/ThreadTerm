/**
 * Electron Logger Configuration
 * OpenWork Desktop - Logging System
 *
 * Features:
 * - Separate log files for main and renderer processes
 * - Log rotation by file size
 * - Configurable log levels
 * - Logs stored in userData/logs directory
 */

const electronLog = require('electron-log');
const path = require('path');
const { app } = require('electron');

// Get userData path (must work before app is ready)
function getUserDataPath() {
  try {
    return app.getPath('userData');
  } catch (error) {
    // Fallback for early initialization
    return path.join(require('os').homedir(), '.claude-code-desktop');
  }
}

// Configure log file paths
const userDataPath = getUserDataPath();
const logsDir = path.join(userDataPath, 'logs');

// Configure electron-log
const log = electronLog;

// Override default log paths
log.transports.file.resolvePathFn = (variables) => {
  // Electron may report main process as "browser" depending on context.
  const processType = variables.processType || process.type || 'main';
  const isMainProcess = processType === 'main' || processType === 'browser';
  const filename = isMainProcess ? 'main.log' : 'renderer.log';
  return path.join(logsDir, filename);
};

// Log level configuration
const isDev = process.env.NODE_ENV === 'development';

// File transport settings
log.transports.file.level = isDev ? 'debug' : 'info';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB max file size
log.transports.file.archiveLogFn = (oldLogPath) => {
  // Custom archive naming: main.log -> main.1.log, main.1.log -> main.2.log, etc.
  const ext = path.extname(oldLogPath);
  const basename = path.basename(oldLogPath, ext);
  const dir = path.dirname(oldLogPath);

  // Find next available number
  let archiveNum = 1;
  while (require('fs').existsSync(path.join(dir, `${basename}.${archiveNum}${ext}`))) {
    archiveNum++;
    if (archiveNum > 5) {
      // Remove oldest log if we exceed 5 backups
      try {
        require('fs').unlinkSync(path.join(dir, `${basename}.5${ext}`));
      } catch (e) {
        // Ignore errors
      }
      // Shift numbers down
      for (let i = 4; i >= 1; i--) {
        try {
          require('fs').renameSync(
            path.join(dir, `${basename}.${i}${ext}`),
            path.join(dir, `${basename}.${i + 1}${ext}`)
          );
        } catch (e) {
          // Ignore errors
        }
      }
      archiveNum = 1;
      break;
    }
  }

  return path.join(dir, `${basename}.${archiveNum}${ext}`);
};

// Console transport settings
log.transports.console.level = isDev ? 'debug' : 'warn';

// Custom format for console output
log.transports.console.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

// File format
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

// Catch unhandled errors and log them
log.catchErrors({
  showDialog: false,
  onError: (error) => {
    log.error('Unhandled error:', error);
  }
});

// Log initialization
log.info('Logger initialized');
log.info(`Log directory: ${logsDir}`);
log.info(`Process type: ${process.type || 'main'}`);
log.info(`Environment: ${isDev ? 'development' : 'production'}`);

module.exports = {
  log,
  logsDir,
  getUserDataPath,
};
