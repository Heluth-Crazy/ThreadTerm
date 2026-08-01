/**
 * Module-level mirror of which terminal cards currently keep a mounted
 * TerminalView. Written by TerminalManager; read by lifecycle diagnostics.
 * Publishing never mounts or unmounts views.
 */

import { MAX_MOUNTED_TERMINAL_VIEWS } from '../../components/terminal/mountedViewsLru';

export interface MountedTerminalSurfacesSnapshot {
  mountedCardIds: string[];
  focusedCardId: string | null;
  floatCardId: string | null;
  maxMountedTerminalViews: number;
  terminalSurfacePoolEnabled: boolean;
}

let snapshot: MountedTerminalSurfacesSnapshot = {
  mountedCardIds: [],
  focusedCardId: null,
  floatCardId: null,
  maxMountedTerminalViews: MAX_MOUNTED_TERMINAL_VIEWS,
  terminalSurfacePoolEnabled: false,
};

export function publishMountedTerminalSurfaces(
  next: Partial<MountedTerminalSurfacesSnapshot>,
): void {
  snapshot = {
    ...snapshot,
    ...next,
    mountedCardIds: next.mountedCardIds
      ? [...next.mountedCardIds]
      : snapshot.mountedCardIds,
  };
}

export function getMountedTerminalSurfaces(): MountedTerminalSurfacesSnapshot {
  return {
    ...snapshot,
    mountedCardIds: [...snapshot.mountedCardIds],
  };
}

/**
 * Derive visible / warm / cold sets for diagnostics.
 * Pre-Batch-2: every mounted id is reported as mounted; warm/cold are empty
 * until the surface pool is enabled.
 */
export function deriveTerminalSurfacePhases(
  input: MountedTerminalSurfacesSnapshot,
): {
  visibleCardIds: string[];
  warmCardIds: string[];
  coldCardIds: string[];
} {
  const visible = new Set<string>();
  if (input.focusedCardId) visible.add(input.focusedCardId);
  if (input.floatCardId) visible.add(input.floatCardId);

  const warmCardIds = input.mountedCardIds.filter((id) => !visible.has(id));
  if (!input.terminalSurfacePoolEnabled) {
    return {
      visibleCardIds: [...visible],
      // Legacy fixed-cap mode still mounts multiple hidden views; report them
      // as warm for sampling even though the pool flag is off.
      warmCardIds,
      coldCardIds: [],
    };
  }

  return {
    visibleCardIds: [...visible],
    warmCardIds,
    coldCardIds: [],
  };
}
