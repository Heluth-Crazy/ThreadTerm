import type { DataCategory } from '../../lib/dataDirectory';

export const CATEGORY_DEFAULT_LABELS: Record<DataCategory, string> = {
  database: 'Database',
  desktop_state: 'Desktop and interface state',
  window_state: 'Window size and position',
};

export function formatDataBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  // parseFloat trims trailing zeros: 384.0 → 384, 2.00 → 2, 1.50 → 1.5
  return `${parseFloat(value.toFixed(value >= 10 ? 1 : 2))} ${unit}`;
}

const WINDOWS_VERBATIM_PREFIX = '\\\\?\\';
const WINDOWS_VERBATIM_UNC_PREFIX = '\\\\?\\UNC\\';

export function formatDataPathForDisplay(path: string): string {
  if (
    path
      .slice(0, WINDOWS_VERBATIM_UNC_PREFIX.length)
      .toUpperCase() === WINDOWS_VERBATIM_UNC_PREFIX.toUpperCase()
  ) {
    return `\\\\${path.slice(WINDOWS_VERBATIM_UNC_PREFIX.length)}`;
  }
  if (path.startsWith(WINDOWS_VERBATIM_PREFIX)) {
    return path.slice(WINDOWS_VERBATIM_PREFIX.length);
  }
  return path;
}

export function parentDirectory(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, '');
}
