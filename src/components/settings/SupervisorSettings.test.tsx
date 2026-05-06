import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SupervisorSettings } from './SupervisorSettings';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';

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
  useTerminalStore.setState({ supervisorEnabled: false });
  useSupervisorStore.setState({
    alerts: [],
    telemetry: { triggered: 0, clicked: 0, acted: 0 },
  });
});

afterEach(() => {
  cleanup();
});

describe('SupervisorSettings', () => {
  it('toggling on calls setSupervisorEnabled(true)', () => {
    render(<SupervisorSettings />);
    const toggle = screen.getByTestId('supervisor-master-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(useTerminalStore.getState().supervisorEnabled).toBe(true);
  });

  it('toggling off calls setSupervisorEnabled(false)', () => {
    useTerminalStore.setState({ supervisorEnabled: true });
    render(<SupervisorSettings />);
    const toggle = screen.getByTestId('supervisor-master-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(useTerminalStore.getState().supervisorEnabled).toBe(false);
  });

  it('renders telemetry counters from useSupervisorStore', () => {
    useSupervisorStore.setState({
      alerts: [],
      telemetry: { triggered: 7, clicked: 3, acted: 2 },
    });
    render(<SupervisorSettings />);
    expect(screen.getByTestId('supervisor-telemetry-triggered').textContent).toBe('7');
    expect(screen.getByTestId('supervisor-telemetry-clicked').textContent).toBe('3');
    expect(screen.getByTestId('supervisor-telemetry-acted').textContent).toBe('2');
  });

  it('clicking "Reset stats" zeroes the telemetry counters', () => {
    useSupervisorStore.setState({
      alerts: [],
      telemetry: { triggered: 5, clicked: 4, acted: 1 },
    });
    render(<SupervisorSettings />);
    expect(screen.getByTestId('supervisor-telemetry-triggered').textContent).toBe('5');
    fireEvent.click(screen.getByTestId('supervisor-telemetry-reset'));
    expect(useSupervisorStore.getState().telemetry).toEqual({
      triggered: 0,
      clicked: 0,
      acted: 0,
    });
    expect(screen.getByTestId('supervisor-telemetry-triggered').textContent).toBe('0');
    expect(screen.getByTestId('supervisor-telemetry-clicked').textContent).toBe('0');
    expect(screen.getByTestId('supervisor-telemetry-acted').textContent).toBe('0');
  });
});
