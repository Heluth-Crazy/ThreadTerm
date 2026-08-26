import type { ExitBehavior } from './protocol';

export function shouldCloseForExit(
  behavior: ExitBehavior,
  exitCode: number | null | undefined,
): boolean {
  if (behavior === 'close-on-exit') return true;
  return behavior === 'close-on-success' && exitCode === 0;
}
