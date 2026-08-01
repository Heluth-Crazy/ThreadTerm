import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  migrationStatus: vi.fn(),
  openSettingsWindow: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
}));

vi.mock('../../lib/dataDirectory', () => ({
  dataDirectory: {
    status: mocks.status,
    migrationStatus: mocks.migrationStatus,
  },
}));

vi.mock('../../lib/settingsWindow', () => ({
  openSettingsWindow: mocks.openSettingsWindow,
}));

import { LegacyDataDirectoryNotice } from './LegacyDataDirectoryNotice';

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue({ mode: 'legacy_split' });
  mocks.migrationStatus.mockReset().mockResolvedValue(null);
  mocks.openSettingsWindow.mockReset().mockResolvedValue(true);
});

afterEach(cleanup);

describe('LegacyDataDirectoryNotice', () => {
  it('offers existing users a non-blocking route to the data settings page', async () => {
    render(<LegacyDataDirectoryNotice />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review data location' }));
    expect(mocks.openSettingsWindow).toHaveBeenCalledWith('data');
    expect(screen.queryByText('Choose one place for ThreadTerm data')).toBeNull();
  });

  it('stays hidden after a migration has already been scheduled', async () => {
    mocks.migrationStatus.mockResolvedValue({ phase: 'scheduled' });
    render(<LegacyDataDirectoryNotice />);

    await Promise.resolve();
    expect(screen.queryByText('Choose one place for ThreadTerm data')).toBeNull();
  });
});
