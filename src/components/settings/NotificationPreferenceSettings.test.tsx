import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useTerminalStore } from '../../stores/terminalStore';
import { NotificationPreferenceSettings } from './NotificationPreferenceSettings';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

beforeEach(() => {
  useTerminalStore.setState({ osNotificationsEnabled: true });
});

afterEach(() => {
  cleanup();
});

describe('NotificationPreferenceSettings', () => {
  it('reflects the current OS-notification preference', () => {
    useTerminalStore.setState({ osNotificationsEnabled: true });
    render(<NotificationPreferenceSettings />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('toggles OS notifications off and on', () => {
    render(<NotificationPreferenceSettings />);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(false);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(true);
  });
});
