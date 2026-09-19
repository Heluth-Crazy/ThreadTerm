const BUILD_ARGUMENT = '--threadterm-windows-build=';

export function terminalWindowArguments(platform: string, osRelease: string): string[] {
  if (platform !== 'win32') return [];
  const build = Number(osRelease.split('.')[2]);
  return Number.isSafeInteger(build) && build > 0 ? [`${BUILD_ARGUMENT}${build}`] : [];
}

/** Parse only the host metadata passed by main; sandboxed preload needs no OS API. */
export function terminalPtyFromArguments(platform: string, args: readonly string[]): { backend: 'conpty'; buildNumber: number } | undefined {
  if (platform !== 'win32') return undefined;
  const value = args.find(arg => arg.startsWith(BUILD_ARGUMENT))?.slice(BUILD_ARGUMENT.length);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const buildNumber = Number(value);
  return Number.isSafeInteger(buildNumber) && buildNumber > 0 ? { backend: 'conpty', buildNumber } : undefined;
}
