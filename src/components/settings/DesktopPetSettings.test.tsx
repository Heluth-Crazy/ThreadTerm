import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_PET_CONFIG } from '../../lib/petConfig';
import { useTerminalStore } from '../../stores/terminalStore';
import { DesktopPetSettings } from './DesktopPetSettings';

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
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
  useTerminalStore.setState({ petConfig: DEFAULT_PET_CONFIG });
});

afterEach(() => {
  cleanup();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('DesktopPetSettings', () => {
  it('toggles the desktop pet master switch', () => {
    render(<DesktopPetSettings />);

    fireEvent.click(screen.getByLabelText('desktopPet.disabled'));

    expect(useTerminalStore.getState().petConfig.enabled).toBe(true);
  });

  it('maps the two notification toggles back to the enum', () => {
    render(<DesktopPetSettings />);

    // Default is 'both' → both toggles checked. Unchecking the pet bubble
    // should collapse the enum to 'system'.
    fireEvent.click(screen.getByLabelText('desktopPet.notify.petBubble'));
    expect(useTerminalStore.getState().petConfig.notificationMode).toBe('system');

    // Re-check pet, uncheck OS → 'pet'.
    fireEvent.click(screen.getByLabelText('desktopPet.notify.petBubble'));
    fireEvent.click(screen.getByLabelText('desktopPet.notify.os'));
    expect(useTerminalStore.getState().petConfig.notificationMode).toBe('pet');
  });

  it('updates skin, position, and size', () => {
    render(<DesktopPetSettings />);

    fireEvent.click(screen.getByLabelText('desktopPet.skin.tuxedo'));
    fireEvent.click(screen.getByLabelText('desktopPet.position.leftBottom'));
    fireEvent.change(screen.getByDisplayValue('96'), { target: { value: '112' } });

    expect(useTerminalStore.getState().petConfig).toMatchObject({
      skin: 'tuxedo',
      defaultPosition: 'leftBottom',
      size: 112,
    });
  });

  it('resets position to the default corner', () => {
    useTerminalStore.setState({
      petConfig: {
        ...DEFAULT_PET_CONFIG,
        defaultPosition: 'lastDragged',
        lastPosition: { x: 10, y: 20 },
      },
    });
    render(<DesktopPetSettings />);

    fireEvent.click(screen.getByText('desktopPet.resetPosition'));

    expect(useTerminalStore.getState().petConfig).toMatchObject({
      defaultPosition: 'rightBottom',
      lastPosition: null,
    });
  });
});
