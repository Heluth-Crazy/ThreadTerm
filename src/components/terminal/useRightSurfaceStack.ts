import { useCallback, useMemo, useState } from 'react';

export type RightSurface =
  | 'stats'
  | 'archive'
  | 'sessionDock'
  | 'sessionRecovery'
  | 'workbench';

function pushRightSurface(stack: RightSurface[], surface: RightSurface): RightSurface[] {
  return [...stack.filter((item) => item !== surface), surface];
}

function removeRightSurface(stack: RightSurface[], surface: RightSurface): RightSurface[] {
  return stack.filter((item) => item !== surface);
}

function resolveActiveRightSurface(
  stack: RightSurface[],
  isAvailable: (surface: RightSurface) => boolean,
): RightSurface | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const surface = stack[i];
    if (isAvailable(surface)) return surface;
  }
  return null;
}

export function useRightSurfaceStack(isAvailable: (surface: RightSurface) => boolean) {
  const [stack, setStack] = useState<RightSurface[]>([]);
  const activeRightSurface = useMemo(
    () => resolveActiveRightSurface(stack, isAvailable),
    [isAvailable, stack],
  );

  const openRightSurface = useCallback((surface: RightSurface) => {
    setStack((current) => pushRightSurface(current, surface));
  }, []);

  const closeRightSurface = useCallback((surface: RightSurface) => {
    setStack((current) => removeRightSurface(current, surface));
  }, []);

  const toggleRightSurface = useCallback(
    (surface: RightSurface) => {
      setStack((current) =>
        activeRightSurface === surface
          ? removeRightSurface(current, surface)
          : pushRightSurface(current, surface),
      );
    },
    [activeRightSurface],
  );

  return {
    activeRightSurface,
    openRightSurface,
    closeRightSurface,
    toggleRightSurface,
  };
}
