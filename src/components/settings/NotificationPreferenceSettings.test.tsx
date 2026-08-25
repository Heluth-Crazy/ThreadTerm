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
  useTerminalStore.setState({
    osNotificationsEnabled: true,
    osNotificationPreviewEnabled: true,
    agentCliCompatibilityCompletionEnabled: true,
  });
});

afterEach(() => {
  cleanup();
});

describe('NotificationPreferenceSettings', () => {
  it('reflects the current OS-notification preference', () => {
    useTerminalStore.setState({ osNotificationsEnabled: true });
    render(<NotificationPreferenceSettings />);
    expect(screen.getByLabelText('notifications.preference.osLabel')).toBeChecked();
    expect(screen.getByLabelText('notifications.preference.previewLabel')).toBeChecked();
    expect(screen.getByLabelText('notifications.preference.compatibilityLabel')).toBeChecked();
  });

  it('toggles OS notifications off and on', () => {
    render(<NotificationPreferenceSettings />);

    const master = screen.getByLabelText('notifications.preference.osLabel');
    fireEvent.click(master);
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(false);

    fireEvent.click(master);
    expect(useTerminalStore.getState().osNotificationsEnabled).toBe(true);
  });

  it('toggles summary preview and Agent CLI compatibility independently', () => {
    render(<NotificationPreferenceSettings />);

    fireEvent.click(screen.getByLabelText('notifications.preference.previewLabel'));
    fireEvent.click(screen.getByLabelText('notifications.preference.compatibilityLabel'));

    expect(useTerminalStore.getState().osNotificationPreviewEnabled).toBe(false);
    expect(useTerminalStore.getState().agentCliCompatibilityCompletionEnabled).toBe(false);
  });
});
