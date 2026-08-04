import { describe, expect, it, vi } from 'vitest';
import { createClaudeChatLifecycleController } from './lifecycle';

describe('Claude Chat card lifecycle', () => {
  it('resets rebuildable state and skips native work outside desktop', async () => {
    const stop = vi.fn(async () => {});
    const resetCard = vi.fn();
    const controller = createClaudeChatLifecycleController({
      stop,
      resetCard,
      isDesktop: () => false,
      now: () => 10,
    });

    const result = await controller.releaseCard('card-a', 'remove');

    expect(result).toMatchObject({ ok: true, attempts: 0 });
    expect(resetCard).toHaveBeenCalledWith('card-a');
    expect(stop).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent cleanup and exposes the in-flight gate', async () => {
    let finish: (() => void) | undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = createClaudeChatLifecycleController({
      stop,
      resetCard: vi.fn(),
      isDesktop: () => true,
      timeoutMs: 1_000,
      retryDelaysMs: [0],
    });

    const first = controller.releaseCard('card-a', 'archive');
    const second = controller.releaseCard('card-a', 'archive');
    expect(second).toBe(first);
    expect(await controller.waitForCard('missing')).toBeNull();
    expect(controller.diagnostics().pendingCount).toBe(1);

    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    finish?.();
    await expect(controller.waitForCard('card-a')).resolves.toMatchObject({ ok: true });
    expect(controller.diagnostics().pendingCount).toBe(0);
  });

  it('retries failures and records a bounded successful outcome', async () => {
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('bridge unavailable'))
      .mockResolvedValue(undefined);
    const controller = createClaudeChatLifecycleController({
      stop,
      resetCard: vi.fn(),
      isDesktop: () => true,
      timeoutMs: 100,
      retryDelaysMs: [0, 0],
      maxDiagnosticRecords: 1,
    });

    await expect(controller.releaseCard('card-a', 'remove')).resolves.toMatchObject({
      ok: true,
      attempts: 2,
    });
    await controller.releaseCard('card-b', 'archive');

    expect(controller.diagnostics()).toMatchObject({
      pendingCount: 0,
      failedCount: 0,
      succeededCount: 2,
      retryCount: 1,
    });
    expect(controller.diagnostics().recent.map((item) => item.cardId)).toEqual(['card-b']);
  });

  it('reports a terminal failure after the retry budget', async () => {
    const onFailure = vi.fn();
    const controller = createClaudeChatLifecycleController({
      stop: vi.fn(async () => {
        throw new Error('sidecar stuck');
      }),
      resetCard: vi.fn(),
      isDesktop: () => true,
      timeoutMs: 100,
      retryDelaysMs: [0, 0, 0],
      onFailure,
    });

    const result = await controller.releaseCard('card-a', 'remove');

    expect(result).toMatchObject({ ok: false, attempts: 3, error: 'sidecar stuck' });
    expect(controller.diagnostics()).toMatchObject({ failedCount: 1, retryCount: 2 });
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
  });

  it('does not accumulate in-flight work over twenty card releases', async () => {
    const controller = createClaudeChatLifecycleController({
      stop: vi.fn(async () => {}),
      resetCard: vi.fn(),
      isDesktop: () => true,
      retryDelaysMs: [0],
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        controller.releaseCard(`card-${index}`, 'archive'),
      ),
    );

    expect(controller.diagnostics()).toMatchObject({
      pendingCount: 0,
      failedCount: 0,
      succeededCount: 20,
    });
  });
});
