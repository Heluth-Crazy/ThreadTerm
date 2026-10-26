/** The QA picker override is ignored in packaged builds and never opens a native dialog on malformed test data. */
export function qaOpenExternalPathsOverride(envValue: string | undefined, isPackaged: boolean): string[] | undefined {
  if (isPackaged || envValue === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(envValue);
    return Array.isArray(value) && value.every(path => typeof path === 'string') ? value : [];
  } catch {
    return [];
  }
}
