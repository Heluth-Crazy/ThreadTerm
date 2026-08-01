import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriEnv: vi.fn(),
}));

vi.mock('./tauri-bridge', () => ({
  invoke: mocks.invoke,
  isTauriEnv: mocks.isTauriEnv,
}));

import {
  confirmDataMigrationAfterManagedStateLoad,
  dataDirectory,
  type DataMigrationStatus,
} from './dataDirectory';

const pointerSwitched: DataMigrationStatus = {
  transactionId: 'migration-1',
  phase: 'pointer_switched',
  sourceRoot: 'C:\\old',
  targetRoot: 'D:\\ThreadTerm Data',
  copiedBytes: 100,
  totalBytes: 100,
  retainSource: true,
  lastError: null,
  restartRequired: false,
  canCancel: false,
  canRollback: true,
  canCleanup: false,
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.isTauriEnv.mockReset().mockReturnValue(true);
});

describe('dataDirectory bridge', () => {
  it('keeps migration command names and camelCase arguments aligned with Rust', async () => {
    mocks.invoke.mockResolvedValue(pointerSwitched);

    await dataDirectory.preflight('D:\\ThreadTerm Data');
    await dataDirectory.schedule('D:\\ThreadTerm Data', true);
    await dataDirectory.cleanupSource('migration-1');
    await dataDirectory.requestRollback('migration-1');
    await dataDirectory.scheduleCacheCleanup();
    await dataDirectory.cancelCacheCleanup();

    expect(mocks.invoke.mock.calls).toEqual([
      ['data_migration_preflight', { targetRoot: 'D:\\ThreadTerm Data' }],
      [
        'data_migration_schedule',
        { targetRoot: 'D:\\ThreadTerm Data', retainSource: true },
      ],
      ['data_migration_cleanup_source', { transactionId: 'migration-1' }],
      ['data_migration_request_rollback', { transactionId: 'migration-1' }],
      ['data_cache_cleanup_schedule'],
      ['data_cache_cleanup_cancel'],
    ]);
  });

  it('confirms a migrated root only after the backend reports pointer switched', async () => {
    mocks.invoke
      .mockResolvedValueOnce(pointerSwitched)
      .mockResolvedValueOnce({ ...pointerSwitched, phase: 'first_launch_confirmed' });

    await confirmDataMigrationAfterManagedStateLoad();

    expect(mocks.invoke.mock.calls).toEqual([
      ['data_migration_status'],
      ['data_migration_confirm'],
    ]);
  });

  it('does not confirm from a browser or for an unrelated migration phase', async () => {
    mocks.isTauriEnv.mockReturnValue(false);
    await confirmDataMigrationAfterManagedStateLoad();
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.isTauriEnv.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ ...pointerSwitched, phase: 'scheduled' });
    await confirmDataMigrationAfterManagedStateLoad();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
