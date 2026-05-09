import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileAccessSettings } from './MobileAccessSettings';

const bridgeMocks = vi.hoisted(() => ({
  status: vi.fn(),
  devices: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  pairQr: vi.fn(),
  revokeDevice: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) =>
      typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key,
  }),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  mobileBridge: bridgeMocks,
}));

describe('MobileAccessSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMocks.status.mockResolvedValue({
      running: false,
      host: null,
      port: null,
      url: null,
    });
    bridgeMocks.devices.mockResolvedValue([]);
    bridgeMocks.start.mockResolvedValue({
      running: true,
      host: '127.0.0.1',
      port: 5174,
      url: 'http://127.0.0.1:5174',
    });
    bridgeMocks.pairQr.mockResolvedValue({
      host: '127.0.0.1',
      port: 5174,
      otp: '123456',
      url: 'http://127.0.0.1:5174/pair?otp=123456',
      expiresInSeconds: 300,
    });
  });

  it('starts on loopback by default', async () => {
    render(<MobileAccessSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /mobileAccess.start/ }));

    await waitFor(() => {
      expect(bridgeMocks.start).toHaveBeenCalledWith('127.0.0.1');
    });
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith('127.0.0.1');
  });

  it('uses an inline confirmation before binding to all interfaces', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, 'confirm', {
      value: confirm,
      configurable: true,
    });
    bridgeMocks.start.mockResolvedValueOnce({
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://127.0.0.1:5174',
    });
    render(<MobileAccessSettings />);

    fireEvent.click(await screen.findByLabelText('mobileAccess.bind.lan'));
    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.start/ }));

    expect(confirm).not.toHaveBeenCalled();
    expect(bridgeMocks.start).not.toHaveBeenCalled();
    expect(screen.getByText('mobileAccess.lanConfirm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.confirmLanStart/ }));

    await waitFor(() => {
      expect(bridgeMocks.start).toHaveBeenCalledWith('0.0.0.0');
    });
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith('0.0.0.0');
  });

  it('disables start and stop controls while an action is running', async () => {
    let resolveStart: (value: unknown) => void = () => {};
    bridgeMocks.start.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );

    render(<MobileAccessSettings />);

    const start = await screen.findByRole('button', { name: /mobileAccess.start/ });
    fireEvent.click(start);

    expect(start).toBeDisabled();

    resolveStart({
      running: true,
      host: '127.0.0.1',
      port: 5174,
      url: 'http://127.0.0.1:5174',
    });

    await waitFor(() => {
      expect(start).not.toBeDisabled();
    });
  });

  it('shows the bridge as running even when pair code creation fails', async () => {
    bridgeMocks.pairQr.mockRejectedValue(new Error('pair code failed'));

    render(<MobileAccessSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /mobileAccess.start/ }));

    await waitFor(() => {
      expect(screen.getByText('mobileAccess.running')).toBeInTheDocument();
    });
    expect(screen.getByText('127.0.0.1:5174')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mobileAccess.newPairCode/ })).toBeInTheDocument();
  });

  it('creates a pair code automatically when the bridge is already running', async () => {
    bridgeMocks.status.mockResolvedValue({
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://127.0.0.1:5174',
    });

    render(<MobileAccessSettings />);

    await waitFor(() => {
      expect(bridgeMocks.pairQr).toHaveBeenCalledWith('0.0.0.0');
    });
    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(
      screen.getByText('http://127.0.0.1:5174/pair?otp=123456&permission=read_only'),
    ).toBeInTheDocument();
  });

  it('still shows a pair code when loading devices fails after start', async () => {
    bridgeMocks.devices
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('devices failed'));

    render(<MobileAccessSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /mobileAccess.start/ }));

    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(
      screen.getByText('http://127.0.0.1:5174/pair?otp=123456&permission=read_only'),
    ).toBeInTheDocument();
    expect(screen.getByText('mobileAccess.running')).toBeInTheDocument();
  });

  it('adds selected pairing permission to the mobile URL', async () => {
    bridgeMocks.status.mockResolvedValue({
      running: true,
      host: '127.0.0.1',
      port: 5174,
      url: 'http://127.0.0.1:5174',
    });

    render(<MobileAccessSettings />);

    expect(
      await screen.findByText('http://127.0.0.1:5174/pair?otp=123456&permission=read_only'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));

    expect(
      screen.getByText('http://127.0.0.1:5174/pair?otp=123456&permission=full'),
    ).toBeInTheDocument();
  });
});
