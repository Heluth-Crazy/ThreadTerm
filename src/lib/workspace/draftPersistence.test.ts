import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDraftPersistenceState, persistDesktopFileDraft } from './draftPersistence';

const mocks = vi.hoisted(() => ({
  isTauriEnv: vi.fn(() => true),
  ensure: vi.fn(),
  openTab: vi.fn(),
  ensureDraft: vi.fn(),
  getDraft: vi.fn(),
  applyDraftPatch: vi.fn(),
}));

vi.mock('../tauri-bridge', () => ({
  isTauriEnv: () => mocks.isTauriEnv(),
}));

vi.mock('./api', () => ({
  workspaceAuthority: {
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

  it('no-ops outside Tauri or when clean', async () => {
    mocks.isTauriEnv.mockReturnValue(false);
    await expect(
      persistDesktopFileDraft({
        rootPath: 'C:/proj',
        path: 'C:/proj/a.ts',
        title: 'a.ts',
        contents: 'x',
        dirty: true,
      }),
    ).resolves.toBe('idle');

    mocks.isTauriEnv.mockReturnValue(true);
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
