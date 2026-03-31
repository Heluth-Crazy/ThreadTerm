/**
 * Global Error Handler
 * OpenWork Desktop - Error Handling Module
 *
 * Features:
 * - Global uncaught exception handling
 * - Unhandled promise rejection handling
 * - Error dialog display for users
 * - File logging via electron-log
 * - Error loop prevention
 * - Environment-specific behavior (dev vs production)
 */

const { dialog, app } = require('electron');

// Error loop prevention
let isErrorHandlerActive = false;
let errorCount = 0;
const MAX_ERRORS = 5;
const ERROR_WINDOW_MS = 60000; // 1 minute
let errorTimestamps = [];

// Track if we've shown the fatal error dialog to prevent multiple dialogs
let fatalErrorDialogShown = false;

// Environment check
const isDev = process.env.NODE_ENV === 'development';

// Logger reference (will be initialized lazily)
let logger = null;

/**
 * Get the logger instance (lazy initialization)
 * Uses the project's logger.cjs if available, falls back to console
 */
function getLogger() {
  if (logger) return logger;

  try {
    const { log } = require('./logger.cjs');
    logger = log;
  } catch (error) {
    // Fallback to console if logger module is not available
    logger = {
      info: console.log,
      error: console.error,
      warn: console.warn,
      debug: console.debug,
    };
  }
  return logger;
}

/**
 * Check if we're in an error loop (too many errors in short time)
 * @returns {boolean} true if error loop detected
 */
function isErrorLoop() {
  const now = Date.now();

  // Remove old timestamps outside the window
  errorTimestamps = errorTimestamps.filter(ts => now - ts < ERROR_WINDOW_MS);

  // Add current error timestamp
  errorTimestamps.push(now);

  // Check if we've exceeded the max errors
  if (errorTimestamps.length > MAX_ERRORS) {
    return true;
  }

  return false;
}

/**
 * Show error dialog to the user
 * @param {string} title - Dialog title
 * @param {string} message - Error message
 * @param {Error} error - The error object
 * @param {boolean} isFatal - Whether this is a fatal error
 */
function showErrorDialog(title, message, error, isFatal = false) {
  // Prevent multiple fatal error dialogs
  if (isFatal && fatalErrorDialogShown) {
    return;
  }

  if (isFatal) {
    fatalErrorDialogShown = true;
  }

  // In development, log to console but don't always show dialog
  if (isDev && !isFatal) {
    return;
  }

  try {
    const errorDetails = error ? `\n\nError details:\n${error.stack || error.message || String(error)}` : '';
    const logLocation = `\n\nLogs are saved to: ${app.getPath('logs')}`;

    const buttons = isFatal
      ? ['Quit Application', 'Copy Error']
      : ['OK', 'Copy Error'];

    const result = dialog.showMessageBoxSync({
      type: isFatal ? 'error' : 'warning',
      title: title,
      message: message,
      detail: `${errorDetails}${logLocation}`,
      buttons: buttons,
      defaultId: 0,
      noLink: true,
    });

    // If user clicked "Copy Error" (index 1)
    if (result === 1) {
      const { clipboard } = require('electron');
      const fullError = `${title}\n${message}\n${error ? error.stack || error.message : ''}`;
      clipboard.writeText(fullError);
    }

    // If fatal error and user clicked "Quit" (index 0)
    if (isFatal && result === 0) {
      app.quit();
    }
  } catch (dialogError) {
    // If dialog fails, at least log it
    getLogger().error('Failed to show error dialog:', dialogError);
    console.error('Failed to show error dialog:', dialogError);
  }
}

/**
 * Log error to file via electron-log
 * @param {string} type - Error type (exception/rejection)
 * @param {Error} error - The error object
 * @param {string} context - Additional context
 */
function logError(type, error, context = '') {
  const errorMessage = error ? (error.stack || error.message || String(error)) : 'Unknown error';
  const logMessage = `[${type}] ${context ? `[${context}] ` : ''}${errorMessage}`;

  getLogger().error(logMessage);

  // Also log to console in development
  if (isDev) {
    console.error(logMessage);
  }
}

/**
 * Handle uncaught exceptions
 * @param {Error} error - The uncaught exception
 */
function handleUncaughtException(error) {
  if (isErrorHandlerActive) {
    return; // Prevent re-entry
  }

  isErrorHandlerActive = true;

  logError('uncaughtException', error, 'Main Process');

  // Check for error loop
  if (isErrorLoop()) {
    getLogger().error('Error loop detected! Too many errors in short time. Quitting application.');
    dialog.showErrorBox(
      'Application Error',
      'The application has encountered multiple errors and will now quit.\n\nPlease check the logs and restart the application.'
    );
    app.quit();
    return;
  }

  // Determine if this is a fatal error
  const isFatal = !isDev; // In production, treat uncaught exceptions as fatal

  showErrorDialog(
    'Application Error',
    'An unexpected error occurred in the application. We apologize for the inconvenience.',
    error,
    isFatal
  );

  isErrorHandlerActive = false;
}

/**
 * Handle unhandled promise rejections
 * @param {any} reason - The rejection reason
 * @param {Promise} promise - The promise that was rejected
 */
function handleUnhandledRejection(reason, promise) {
  if (isErrorHandlerActive) {
    return; // Prevent re-entry
  }

  isErrorHandlerActive = true;

  // Convert reason to Error if needed
  const error = reason instanceof Error ? reason : new Error(String(reason));

  logError('unhandledRejection', error, 'Promise Rejection');

  // Check for error loop
  if (isErrorLoop()) {
    getLogger().warn('Multiple unhandled rejections detected. Check application stability.');
  }

  // In development, just log and continue
  // In production, show a warning but don't quit (promises are less critical)
  if (!isDev) {
    showErrorDialog(
      'Application Warning',
      'An unexpected issue occurred. The application will continue running, but may not function correctly.',
      error,
      false // Not fatal
    );
  }

  isErrorHandlerActive = false;
}

/**
 * Handle renderer process crashes
 * @param {Event} event - The crash event
 * @param {string} killed - Whether the process was killed
 */
function handleRendererCrash(event, killed) {
  logError('rendererCrash', new Error(`Renderer process crashed. Killed: ${killed}`), 'Renderer');

  showErrorDialog(
    'Application Error',
    'The application window has crashed. Please restart the application.',
    new Error(`Renderer process crashed. Killed: ${killed}`),
    true // Fatal - renderer crash is serious
  );
}

/**
 * Initialize the global error handler
 * This should be called early in the main process startup
 */
function initErrorHandler() {
  // Register global error handlers
  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);

  getLogger().info('Global error handler initialized');

  // Return cleanup function
  return {
    dispose: () => {
      process.removeListener('uncaughtException', handleUncaughtException);
      process.removeListener('unhandledRejection', handleUnhandledRejection);
      getLogger().info('Global error handler disposed');
    },
    // Expose log function for manual error logging
    logError: (message, error) => {
      logError('manual', error || new Error(message), message);
    },
    // Expose showErrorDialog for manual error display
    showErrorDialog: showErrorDialog,
  };
}

module.exports = {
  initErrorHandler,
  logError,
  showErrorDialog,
};
