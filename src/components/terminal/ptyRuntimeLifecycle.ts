export type PtyRuntimeDisposeReason =
  | 'card-removed'
  | 'pty-replaced'
  | 'exit'
  | 'bridge-unmount'
  | 'runtime-replaced';

export interface PtyRuntimeIdentity {
  ptyId: string;
  cardId: string;
  generation: number;
}
export interface PtyRuntimeLifecycleDiagnostics {
  activeCount: number;
  runtimes: PtyRuntimeIdentity[];
}

type DisposeRuntime = (
  runtime: PtyRuntimeIdentity,
  reason: PtyRuntimeDisposeReason,
) => void;

/**
 * Owns the identity/generation of frontend-only PTY runtime state.
 *
 * A PTY id can be observed again after card deletion, HMR, or a restart. A
 * monotonically increasing generation keeps a delayed headless callback or
 * cleanup from the previous observation from mutating the replacement.
 */
export function createPtyRuntimeLifecycle(disposeRuntime: DisposeRuntime) {
  const active = new Map<string, PtyRuntimeIdentity>();
  let nextGeneration = 0;

  const activate = (ptyId: string, cardId: string): PtyRuntimeIdentity => {
    const existing = active.get(ptyId);
    if (existing?.cardId === cardId) return existing;

    if (existing) {
      active.delete(ptyId);
      disposeRuntime(existing, 'runtime-replaced');
    }

    const runtime = {
      ptyId,
      cardId,
      generation: ++nextGeneration,
    };
    active.set(ptyId, runtime);
    return runtime;
  };

  const isCurrent = (ptyId: string, generation: number): boolean =>
    active.get(ptyId)?.generation === generation;

  const dispose = (
    ptyId: string,
    reason: PtyRuntimeDisposeReason,
    expectedGeneration?: number,
  ): boolean => {
    const runtime = active.get(ptyId);
    if (!runtime || (expectedGeneration !== undefined && runtime.generation !== expectedGeneration)) {
      return false;
    }
    active.delete(ptyId);
    disposeRuntime(runtime, reason);
    return true;
  };

  const disposeAll = (reason: PtyRuntimeDisposeReason): void => {
    const runtimes = Array.from(active.values());
    active.clear();
    for (const runtime of runtimes) disposeRuntime(runtime, reason);
  };

  const getDiagnostics = (): PtyRuntimeLifecycleDiagnostics => ({
    activeCount: active.size,
    runtimes: Array.from(active.values(), (runtime) => ({ ...runtime })),
  });

  return {
    activate,
    isCurrent,
    dispose,
    disposeAll,
    getDiagnostics,
  };
}
