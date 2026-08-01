import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DataDirectoryStatus,
  DataMigrationPreflight,
  DataMigrationStatus,
} from '../../lib/dataDirectory';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  migrationStatus: vi.fn(),
  preflight: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  cleanupSource: vi.fn(),
  requestRollback: vi.fn(),
  restart: vi.fn(),
  cacheCleanupStatus: vi.fn(),
  scheduleCacheCleanup: vi.fn(),
  cancelCacheCleanup: vi.fn(),
  openDialog: vi.fn(),
  openLocalDirectory: vi.fn(),
  confirmDialog: vi.fn(),
  getAllSessionStates: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.openDialog,
}));

vi.mock('../../lib/dataDirectory', () => ({
  dataDirectory: {
    status: mocks.status,
    migrationStatus: mocks.migrationStatus,
    preflight: mocks.preflight,
    schedule: mocks.schedule,
    cancel: mocks.cancel,
    cleanupSource: mocks.cleanupSource,
    requestRollback: mocks.requestRollback,
    restart: mocks.restart,
    cacheCleanupStatus: mocks.cacheCleanupStatus,
    scheduleCacheCleanup: mocks.scheduleCacheCleanup,
    cancelCacheCleanup: mocks.cancelCacheCleanup,
  },
}));

vi.mock('../../lib/localDirectory', () => ({
  openLocalDirectory: mocks.openLocalDirectory,
}));

vi.mock('../../lib/nativeDialog', () => ({
  confirmDialog: mocks.confirmDialog,
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  pty: {
    getAllSessionStates: mocks.getAllSessionStates,
  },
}));

import { DataDirectorySettings } from './DataDirectorySettings';

const directoryStatus: DataDirectoryStatus = {
  mode: 'legacy_split',
  root: null,
  applicationPath: 'C:\\Program Files\\ThreadTerm\\threadterm.exe',
  recommendedRoot: 'D:\\ThreadTerm Data',
  bootstrapPointerPath:
    'C:\\Users\\tester\\AppData\\Roaming\\ThreadTerm\\data-location.json',
  totalBytes: 1_048_576,
  platformNotes: [],
  startupMigration: null,
  categories: [
    {
      category: 'database',
      paths: ['C:\\Users\\tester\\.threadterm'],
      bytes: 1024,
      fileCount: 1,
      exists: true,
      measurable: true,
    },
    {
      category: 'desktop_state',
      paths: ['C:\\Users\\tester\\AppData\\Local\\ThreadTerm\\EBWebView'],
      bytes: 1_000_000,
      fileCount: 20,
      exists: true,
      measurable: true,
    },
    {
      category: 'window_state',
      paths: ['C:\\Users\\tester\\AppData\\Roaming\\ThreadTerm\\.window-state.json'],
      bytes: 200,
      fileCount: 1,
      exists: true,
      measurable: true,
    },
  ],
};

const preflight: DataMigrationPreflight = {
  targetRoot: 'D:\\ThreadTerm Data',
  sourceBytes: 1_048_576,
  requiredBytes: 67_108_864,
  availableBytes: 500_000_000_000,
  warnings: [],
};

const scheduled: DataMigrationStatus = {
  transactionId: 'migration-1',
  phase: 'scheduled',
  sourceRoot: 'C:\\Users\\tester\\.threadterm',
  targetRoot: 'D:\\ThreadTerm Data',
  copiedBytes: 0,
  totalBytes: 1_048_576,
  retainSource: true,
  lastError: null,
  restartRequired: true,
  canCancel: true,
  canRollback: false,
  canCleanup: false,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.status.mockResolvedValue(directoryStatus);
  mocks.migrationStatus.mockResolvedValue(null);
  mocks.cacheCleanupStatus.mockResolvedValue({
    supported: true,
    scheduled: false,
    restartRequired: false,
    bytes: 2048,
    paths: ['C:\\cache'],
  });
  mocks.preflight.mockResolvedValue(preflight);
  mocks.schedule.mockResolvedValue(scheduled);
  mocks.restart.mockResolvedValue(undefined);
  mocks.scheduleCacheCleanup.mockResolvedValue({
    supported: true,
    scheduled: true,
    restartRequired: true,
    bytes: 2048,
    paths: ['C:\\cache'],
  });
  mocks.confirmDialog.mockResolvedValue(true);
  mocks.getAllSessionStates.mockResolvedValue({});
});

afterEach(cleanup);

describe('DataDirectorySettings', () => {
  it('shows the application, all three owned data categories, and the pointer exception', async () => {
    render(<DataDirectorySettings />);

    expect(
      await screen.findByText('C:\\Program Files\\ThreadTerm\\threadterm.exe'),
    ).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Desktop and interface state')).toBeInTheDocument();
    expect(screen.getByText('Window size and position')).toBeInTheDocument();
    expect(screen.getByText('Startup location pointer')).toBeInTheDocument();
    expect(screen.getByText('Rebuildable desktop cache')).toBeInTheDocument();
    expect(screen.getByDisplayValue('D:\\ThreadTerm Data')).toBeInTheDocument();
  });

  it('hides Windows system path prefixes without changing the path used to open folders', async () => {
    const rawRoot = '\\\\?\\D:\\project\\ThreadTermData';
    mocks.status.mockResolvedValue({
      ...directoryStatus,
      mode: 'managed',
      root: rawRoot,
      recommendedRoot: rawRoot,
      applicationPath: '\\\\?\\C:\\Program Files\\ThreadTerm\\threadterm.exe',
      bootstrapPointerPath:
        '\\\\?\\C:\\Users\\tester\\AppData\\Roaming\\ThreadTerm\\data-location.json',
      categories: directoryStatus.categories.map((category) => ({
        ...category,
        paths: category.paths.map((path) => `\\\\?\\${path}`),
      })),
    });

    render(<DataDirectorySettings />);

    const displayedRoot = await screen.findByText('D:\\project\\ThreadTermData');
    expect(screen.queryByText(rawRoot)).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('D:\\project\\ThreadTermData')).toBeInTheDocument();

    const rootCard = displayedRoot.closest('.rounded-lg');
    expect(rootCard).not.toBeNull();
    fireEvent.click(
      within(rootCard as HTMLElement).getByRole('button', { name: 'Open folder' }),
    );

    await waitFor(() => {
      expect(mocks.openLocalDirectory).toHaveBeenCalledWith(rawRoot);
    });
  });

  it('checks the destination before scheduling and keeps the old copy by default', async () => {
    render(<DataDirectorySettings />);
    await screen.findByDisplayValue('D:\\ThreadTerm Data');

    fireEvent.click(screen.getByRole('button', { name: 'Check folder' }));
    await screen.findByText('This folder is ready for migration.');
    fireEvent.click(
      screen.getByRole('button', { name: 'Move after I close ThreadTerm' }),
    );

    await waitFor(() => {
      expect(mocks.schedule).toHaveBeenCalledWith('D:\\ThreadTerm Data', true);
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Migration is scheduled. Your current terminals will keep running until you close ThreadTerm.',
      ),
    ).toBeInTheDocument();
  });

  it('warns about open terminals before an immediate restart', async () => {
    mocks.getAllSessionStates.mockResolvedValue({
      'pty-1': 'Running',
      'pty-2': 'WaitingForInput',
    });
    render(<DataDirectorySettings />);
    await screen.findByDisplayValue('D:\\ThreadTerm Data');

    fireEvent.click(screen.getByRole('button', { name: 'Check folder' }));
    await screen.findByText('This folder is ready for migration.');
    fireEvent.click(screen.getByRole('button', { name: 'Restart and move now' }));

    await waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalledTimes(1));
    expect(mocks.getAllSessionStates).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
  });
});
