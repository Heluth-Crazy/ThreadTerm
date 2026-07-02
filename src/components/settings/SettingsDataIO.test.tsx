import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsDataIO } from './SettingsDataIO';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';

const mocks = vi.hoisted(() => ({
  themeState: {
    themeMode: 'system',
    themePackId: 'threadterm-default',
    themePacks: [],
    setThemePreference: vi.fn(),
    replaceCustomThemePacks: vi.fn(),
  },
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => mocks.themeState,
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

function incomingFile(sections: Record<string, unknown>): File {
  return new File(
    [
      JSON.stringify({
        app: 'ThreadTerm',
        kind: 'threadterm-settings-bundle',
        schemaVersion: 1,
        exportedAt: '2026-05-04T00:00:00.000Z',
        sections,
      }),
    ],
    'threadterm-settings.json',
    { type: 'application/json' },
  );
}

beforeEach(() => {
  mocks.themeState.themeMode = 'system';
  mocks.themeState.themePackId = 'threadterm-default';
  mocks.themeState.themePacks = [];
  mocks.themeState.setThemePreference.mockReset();
  mocks.themeState.replaceCustomThemePacks.mockReset();
  useTerminalStore.setState({
    bottomBarHidden: false,
    aiExplainDefaultProvider: 'claude',
    osNotificationsEnabled: true,
  });
  useOverlayStore.setState({
    selectorMode: 'tile',
    hotkeyA: 'CmdOrCtrl+Shift+Space',
    hotkeyB: 'CmdOrCtrl+Shift+O',
  });
});

afterEach(() => {
  cleanup();
});

describe('SettingsDataIO', () => {
  it('renders an import diff and applies selected terminal and overlay settings', async () => {
    render(<SettingsDataIO />);

    fireEvent.change(screen.getByTestId('settings-bundle-file-input'), {
      target: {
        files: [
          incomingFile({
            terminal: {
              bottomBarHidden: true,
              aiExplainDefaultProvider: 'gemini',
              petConfig: {
                enabled: true,
                notificationMode: 'both',
              },
            },
            overlay: {
              selectorMode: 'carousel',
              hotkeyA: 'CmdOrCtrl+Alt+A',
              hotkeyB: 'CmdOrCtrl+Alt+B',
            },
          }),
        ],
      },
    });

    expect(await screen.findByText('Import preview')).toBeInTheDocument();
    expect(screen.getByText('Terminal preferences')).toBeInTheDocument();
    expect(screen.getByText('Overlay hotkeys')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Apply selected'));

    await waitFor(() => {
      expect(useTerminalStore.getState().bottomBarHidden).toBe(true);
      expect(useTerminalStore.getState().aiExplainDefaultProvider).toBe('gemini');
      expect(useTerminalStore.getState().osNotificationsEnabled).toBe(true);
      expect(useOverlayStore.getState().selectorMode).toBe('carousel');
      expect(useOverlayStore.getState().hotkeyA).toBe('CmdOrCtrl+Alt+A');
      expect(useOverlayStore.getState().hotkeyB).toBe('CmdOrCtrl+Alt+B');
    });
  });

  it('lets users leave an import section unchecked', async () => {
    render(<SettingsDataIO />);

    fireEvent.change(screen.getByTestId('settings-bundle-file-input'), {
      target: {
        files: [
          incomingFile({
            terminal: {
              bottomBarHidden: true,
              aiExplainDefaultProvider: 'codex',
            },
            overlay: {
              selectorMode: 'carousel',
              hotkeyA: 'CmdOrCtrl+Alt+A',
              hotkeyB: 'CmdOrCtrl+Alt+B',
            },
          }),
        ],
      },
    });

    expect(await screen.findByText('Import preview')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Overlay hotkeys/));
    fireEvent.click(screen.getByText('Apply selected'));

    await waitFor(() => {
      expect(useTerminalStore.getState().aiExplainDefaultProvider).toBe('codex');
      expect(useOverlayStore.getState().selectorMode).toBe('tile');
      expect(useOverlayStore.getState().hotkeyA).toBe('CmdOrCtrl+Shift+Space');
    });
  });
});
