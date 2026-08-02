import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDraftPersistenceState, persistDesktopFileDraft } from './draftPersistence';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  openTab: vi.fn(),
  ensureDraft: vi.fn(),
  getDraft: vi.fn(),
  applyDraftPatch: vi.fn(),
}));

vi.mock('./client', () => ({
  workspaceClient: {
    ensure: mocks.ensure,
    openTab: mocks.openTab,
    ensureDraft: mocks.ensureDraft,
    getDraft: mocks.getDraft,
    applyDraftPatch: mocks.applyDraftPatch,
  },
}));

describe('persistDesktopFileDraft', () => {
  afterEach(() => {
    clearDraftPersistenceState();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('no-ops when clean or missing root', async () => {
    await expect(
      persistDesktopFileDraft({
        rootPath: '',
        path: 'C:/proj/a.ts',
        title: 'a.ts',
        contents: 'x',
        dirty: true,
      }),
    ).resolves.toBe('idle');

    await expect(
      persistDesktopFileDraft({
        rootPath: 'C:/proj',
        path: 'C:/proj/a.ts',
        title: 'a.ts',
        contents: 'x',
        dirty: false,
      }),
    ).resolves.toBe('idle');
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it('debounces and acknowledges durable patches as synced', async () => {
    vi.useFakeTimers();
    mocks.ensure.mockResolvedValue({ id: 'ws1' });
    mocks.openTab.mockResolvedValue({ id: 'file:a.ts' });
    mocks.ensureDraft.mockResolvedValue({});
    mocks.getDraft.mockResolvedValue({ revision: 0 });
    mocks.applyDraftPatch.mockResolvedValue({ revision: 1, dirty: true, sizeBytes: 1 });

    const first = persistDesktopFileDraft({
      rootPath: 'C:/proj',
      path: 'C:/proj/a.ts',
      title: 'a.ts',
      contents: 'hello',
      dirty: true,
    });
    await expect(first).resolves.toBe('pending');

    await vi.advanceTimersByTimeAsync(450);
    expect(mocks.applyDraftPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws1',
        tabId: 'file:a.ts',
        fullText: 'hello',
        baseRevision: 0,
      }),
      expect.objectContaining({ requireLease: false }),
    );
  });
});
