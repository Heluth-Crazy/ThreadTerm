// server/utils/logger.js
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'error' : 'debug');
const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[LOG_LEVEL] ?? 0;

export const logger = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
