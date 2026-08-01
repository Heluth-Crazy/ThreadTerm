import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preload: vi.fn(),
  getItem: vi.fn(),
  changeLanguage: vi.fn(),
  terminalRehydrate: vi.fn(),
  workbenchRehydrate: vi.fn(),
  overlayRehydrate: vi.fn(),
  confirmMigration: vi.fn(),
}));

vi.mock('../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
}));

vi.mock('../lib/managedState', () => ({
  MANAGED_STATE_KEYS: {
    terminal: 'threadterm-terminal-store',
    workbench: 'threadterm-workbench-store',
    overlay: 'threadterm-overlay',
    language: 'userLanguage',
    themeMode: 'themeMode',
    themePack: 'themePackId',
    legacyTheme: 'theme',
    customThemes: 'threadterm-custom-theme-packs',
    previewUrls: 'threadterm-html-preview-service-urls',
    shortcutHintDismissed: 'threadterm-shortcut-hint-dismissed',
  },
  preloadManagedState: mocks.preload,
  getPreloadedManagedStateItem: mocks.getItem,
}));

vi.mock('../lib/dataDirectory', () => ({
  confirmDataMigrationAfterManagedStateLoad: mocks.confirmMigration,
}));

vi.mock('../i18n/config', () => ({
  default: {
    language: 'zh-CN',
    changeLanguage: mocks.changeLanguage,
  },
}));

vi.mock('../stores/terminalStore', () => ({
  useTerminalStore: {
    persist: { rehydrate: mocks.terminalRehydrate },
  },
}));

vi.mock('../stores/workbenchStore', () => ({
  useWorkbenchStore: {
    persist: { rehydrate: mocks.workbenchRehydrate },
  },
}));

vi.mock('../stores/overlayStore', () => ({
  useOverlayStore: {
    persist: { rehydrate: mocks.overlayRehydrate },
  },
}));

import {
  ManagedStateBootstrap,
  resetManagedStateBootstrapForTests,
} from './ManagedStateBootstrap';

beforeEach(() => {
  resetManagedStateBootstrapForTests();
  mocks.preload.mockReset().mockResolvedValue(undefined);
  mocks.getItem.mockReset().mockReturnValue(null);
  mocks.changeLanguage.mockReset().mockResolvedValue(undefined);
  mocks.terminalRehydrate.mockReset().mockResolvedValue(undefined);
  mocks.workbenchRehydrate.mockReset().mockResolvedValue(undefined);
  mocks.overlayRehydrate.mockReset().mockResolvedValue(undefined);
  mocks.confirmMigration.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('ManagedStateBootstrap', () => {
  it('mounts the application only after all managed state is ready', async () => {
    mocks.getItem.mockReturnValue('en');

    render(
      <ManagedStateBootstrap>
        <div>application-ready</div>
      </ManagedStateBootstrap>,
    );

    expect(screen.queryByText('application-ready')).toBeNull();
    expect(screen.getByText('正在读取 ThreadTerm 数据…')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('application-ready')).toBeTruthy());

    expect(mocks.preload).toHaveBeenCalledTimes(1);
    expect(mocks.changeLanguage).toHaveBeenCalledWith('en');
    expect(mocks.terminalRehydrate).toHaveBeenCalledTimes(1);
    expect(mocks.workbenchRehydrate).toHaveBeenCalledTimes(1);
    expect(mocks.overlayRehydrate).toHaveBeenCalledTimes(1);
    expect(mocks.confirmMigration).toHaveBeenCalledTimes(1);
  });

  it('keeps the application hidden on read failure and supports retry', async () => {
    mocks.preload
      .mockRejectedValueOnce(new Error('selected disk unavailable'))
      .mockResolvedValueOnce(undefined);

    render(
      <ManagedStateBootstrap>
        <div>application-ready</div>
      </ManagedStateBootstrap>,
    );

    await waitFor(() => {
      expect(screen.getByText('无法读取 ThreadTerm 数据')).toBeTruthy();
    });
    expect(screen.getByText('selected disk unavailable')).toBeTruthy();
    expect(screen.queryByText('application-ready')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('application-ready')).toBeTruthy());
    expect(mocks.preload).toHaveBeenCalledTimes(2);
  });
});
