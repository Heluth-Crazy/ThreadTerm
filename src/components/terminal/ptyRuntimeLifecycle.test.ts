import { describe, expect, it, vi } from 'vitest';
import { createPtyRuntimeLifecycle } from './ptyRuntimeLifecycle';

describe('createPtyRuntimeLifecycle', () => {
  it('disposes a runtime once and keeps cleanup idempotent', () => {
    const dispose = vi.fn();
    const lifecycle = createPtyRuntimeLifecycle(dispose);
    const runtime = lifecycle.activate('pty-1', 'card-1');

    expect(lifecycle.dispose('pty-1', 'card-removed', runtime.generation)).toBe(true);
    expect(lifecycle.dispose('pty-1', 'card-removed', runtime.generation)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.getDiagnostics().activeCount).toBe(0);
  });

  it('does not let an old cleanup generation dispose a replacement session', () => {
    const dispose = vi.fn();
    const lifecycle = createPtyRuntimeLifecycle(dispose);
    const oldRuntime = lifecycle.activate('pty-reused', 'card-old');
    const replacement = lifecycle.activate('pty-reused', 'card-new');

    expect(replacement.generation).toBeGreaterThan(oldRuntime.generation);
    expect(lifecycle.dispose('pty-reused', 'exit', oldRuntime.generation)).toBe(false);
    expect(lifecycle.isCurrent('pty-reused', replacement.generation)).toBe(true);
    expect(lifecycle.getDiagnostics().runtimes).toEqual([replacement]);
  });

  it('disposes every active runtime on bridge unmount', () => {
    const dispose = vi.fn();
    const lifecycle = createPtyRuntimeLifecycle(dispose);
    lifecycle.activate('pty-a', 'card-a');
    lifecycle.activate('pty-b', 'card-b');

    lifecycle.disposeAll('bridge-unmount');

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(lifecycle.getDiagnostics().activeCount).toBe(0);
  });
});
