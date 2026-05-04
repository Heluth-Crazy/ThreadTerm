import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FocusModeSettings } from './FocusModeSettings';
import { useTerminalStore } from '../../stores/terminalStore';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && 'defaultValue' in opts) return opts.defaultValue as string;
        return key;
      },
      i18n: { changeLanguage: () => Promise.resolve() },
    }),
  };
});

beforeEach(() => {
  useTerminalStore.setState({
    bottomBarHidden: false,
    aiExplainDefaultProvider: 'claude',
  });
});

afterEach(() => {
  cleanup();
});

describe('FocusModeSettings', () => {
  it('toggling the chip strip checkbox updates bottomBarHidden', () => {
    render(<FocusModeSettings />);
    const toggle = screen.getByTestId('focus-mode-chip-strip-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(useTerminalStore.getState().bottomBarHidden).toBe(true);
    fireEvent.click(toggle);
    expect(useTerminalStore.getState().bottomBarHidden).toBe(false);
  });

  it('clicking a provider updates aiExplainDefaultProvider', () => {
    render(<FocusModeSettings />);
    fireEvent.click(screen.getByTestId('focus-mode-provider-gemini'));
    expect(useTerminalStore.getState().aiExplainDefaultProvider).toBe('gemini');
    fireEvent.click(screen.getByTestId('focus-mode-provider-codex'));
    expect(useTerminalStore.getState().aiExplainDefaultProvider).toBe('codex');
  });

  it('shows the active provider as aria-pressed', () => {
    useTerminalStore.setState({ aiExplainDefaultProvider: 'gemini' });
    render(<FocusModeSettings />);
    expect(screen.getByTestId('focus-mode-provider-gemini')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('focus-mode-provider-claude')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
