export type WindowChrome = 'native' | 'transparent';

// Windows 11 (build 22000+) lets DWM round an opaque window itself via the
// `roundedCorners` option; older Windows has no such clip, so the window is
// transparent and the renderer rounds .app-shell in CSS. Non-Windows platforms
// keep the transparent path, matching the existing behavior. The override env
// (THREADTERM_V3_WINDOW_CHROME) exists so either path can be exercised on any OS.
export function resolveWindowChrome(platform: string, releaseVersion: string, override?: string): WindowChrome {
  if (override === 'native' || override === 'transparent') return override;
  const build = Number(releaseVersion.split('.')[2]);
  return platform === 'win32' && Number.isInteger(build) && build >= 22000 ? 'native' : 'transparent';
}
