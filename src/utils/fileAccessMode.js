export const FILE_ACCESS_MODE_STORAGE_KEY = 'openwork-file-access-mode';

export const FILE_ACCESS_MODES = Object.freeze({
  AUTO: 'Auto',
  TERMINAL_FIRST: 'Terminal First',
  DIRECT: 'Direct',
});

export function normalizeFileAccessMode(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();

  if (!value || value === 'auto' || value === '自动') {
    return FILE_ACCESS_MODES.AUTO;
  }

  if (
    value === 'terminal first' ||
    value === 'terminal-first' ||
    value === 'terminal_first' ||
    value === 'terminalfirst' ||
    value === 'compatibility' ||
    value === 'compatibility mode' ||
    value === '兼容模式'
  ) {
    return FILE_ACCESS_MODES.TERMINAL_FIRST;
  }

  if (
    value === 'direct' ||
    value === 'high performance' ||
    value === 'high-performance' ||
    value === '高性能模式'
  ) {
    return FILE_ACCESS_MODES.DIRECT;
  }

  return FILE_ACCESS_MODES.AUTO;
}

export function getStoredFileAccessMode() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return FILE_ACCESS_MODES.AUTO;
  }

  try {
    return normalizeFileAccessMode(window.localStorage.getItem(FILE_ACCESS_MODE_STORAGE_KEY));
  } catch (error) {
    console.warn('[file-access] Failed to read file access mode from localStorage:', error);
    return FILE_ACCESS_MODES.AUTO;
  }
}
