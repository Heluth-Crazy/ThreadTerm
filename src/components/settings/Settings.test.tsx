import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Settings from './Settings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('../../theme/ThemeContext', () => ({
  useTheme: () => ({
    themeMode: 'dark',
    themePackId: 'threadterm-dark',
    resolvedMode: 'dark',
    themePacks: [],
    setThemeMode: vi.fn(),
    setThemePackId: vi.fn(),
    importCustomThemePack: vi.fn(),
    deleteCustomThemePack: vi.fn(),
    exportThemePack: vi.fn(),
  }),
}));

vi.mock('./LanguageSelector', () => ({
  default: () => <div>language selector</div>,
}));

vi.mock('./NotificationSettings', () => ({
  NotificationSettings: () => <div>notification settings</div>,
}));

vi.mock('./DesktopPetSettings', () => ({
  DesktopPetSettings: () => <div>desktop pet settings</div>,
}));

vi.mock('./OverlayHotkeysSettings', () => ({
  default: () => <div>overlay hotkeys settings</div>,
}));

vi.mock('./KeyboardShortcutsSettings', () => ({
  default: () => <div>keyboard shortcuts settings</div>,
}));

vi.mock('./SupervisorSettings', () => ({
  SupervisorSettings: () => <div>supervisor settings</div>,
}));

vi.mock('./SettingsDataIO', () => ({
  SettingsDataIO: () => <div>settings data io</div>,
}));

vi.mock('../../lib/nativeDialog', () => ({
  confirmDialog: vi.fn(),
}));

describe('Settings', () => {
  it('does not render mobile access in the shortcuts settings page', () => {
    render(<Settings isOpen embedded initialTab="shortcuts" />);

    expect(screen.getByText('keyboard shortcuts settings')).toBeInTheDocument();
    expect(screen.queryByText('mobileAccess.title')).toBeNull();
  });
});
