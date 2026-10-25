export function normalizeRelocationPath(value: string, platform: string): string {
  if (platform !== 'win32') return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[a-z]:\\/i.test(value)) return value.slice(4);
  return value;
}

export function canonicalRelocationPath(value: string, realpath: (path: string) => string, platform: string): string {
  return realpath(normalizeRelocationPath(value, platform)).toLowerCase();
}
