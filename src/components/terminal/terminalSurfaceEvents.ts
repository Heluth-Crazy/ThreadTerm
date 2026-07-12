export const TERMINAL_SURFACE_SHOWN_EVENT = 'threadterm-terminal-surface-shown';
export const TERMINAL_GEOMETRY_INVALIDATED_EVENT =
  'threadterm-terminal-geometry-invalidated';

export interface TerminalSurfaceShownDetail {
  focus?: boolean;
}

export interface TerminalGeometryInvalidatedDetail {
  ptyId?: string;
}

export function notifyTerminalSurfaceShown(focus = true): void {
  window.dispatchEvent(
    new CustomEvent<TerminalSurfaceShownDetail>(TERMINAL_SURFACE_SHOWN_EVENT, {
      detail: { focus },
    }),
  );
}

export function invalidateTerminalGeometry(ptyId?: string): void {
  window.dispatchEvent(
    new CustomEvent<TerminalGeometryInvalidatedDetail>(TERMINAL_GEOMETRY_INVALIDATED_EVENT, {
      detail: { ptyId },
    }),
  );
}
