/**
 * A live gap means bytes were lost while the same xterm parser kept going, so
 * the screen may no longer match the process (R3). Missing bytes can carry mode
 * switches, alternate-screen changes or half an escape sequence, so the
 * uncertainty is sticky until a new full replay rebuilds the screen.
 */
export type ScreenFidelity = { kind: 'exact' } | { kind: 'inexact'; fromCursor: number; reason: 'output-gap' };

export const EXACT: ScreenFidelity = { kind: 'exact' };

/** Sticky: once inexact, stays inexact (keeps the first fromCursor) until a new full replay. */
export function fidelityAfterLiveGap(current: ScreenFidelity, cursor: number): ScreenFidelity {
  return current.kind === 'inexact' ? current : { kind: 'inexact', fromCursor: cursor, reason: 'output-gap' };
}

export function screenFidelityLabel(zh: boolean): string {
  return zh ? '画面可能不准确' : 'Screen may be inaccurate';
}

export function screenFidelityDetail(zh: boolean): string {
  return zh
    ? '终端运行时丢失了部分输出，画面的某些部分可能不正确；新的输出仍会显示。'
    : 'Some output was lost while this terminal was running, so parts of the screen may be wrong. New output still shows.';
}
