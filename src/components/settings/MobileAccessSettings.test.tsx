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

const themeMocks = vi.hoisted(() => ({
  activeThemeTokens: {
    app: {
      background: '#10151d',
      card: '#151b24',
      primary: '#4f8bd6',
      foreground: '#e8edf5',
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) =>
      typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, title }: { value: string; title?: string }) => (
    <svg data-testid="pair-qr-code" data-value={value} aria-label={title} />
  ),
}));

vi.mock('../../lib/tauri-bridge', () => ({
  isTauriEnv: () => true,
  mobileBridge: bridgeMocks,
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => themeMocks,
}));

const readOnlyPairUrl =
  'http://192.168.1.67:5174/pair?otp=123456&permission=read_only&theme_bg=%2310151d&theme_card=%23151b24&theme_primary=%234f8bd6&theme_fg=%23e8edf5&lang=en';

const fullPairUrl =
  'http://192.168.1.67:5174/pair?otp=123456&permission=full&theme_bg=%2310151d&theme_card=%23151b24&theme_primary=%234f8bd6&theme_fg=%23e8edf5&lang=en';

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
      host: '0.0.0.0',
      port: 5174,
      url: 'http://192.168.1.67:5174',
    });
    bridgeMocks.pairQr.mockResolvedValue({
      host: '192.168.1.67',
      port: 5174,
      otp: '123456',
      url: 'http://192.168.1.67:5174/pair?otp=123456',
      expiresInSeconds: 300,
    });
  });

  it('uses LAN binding by default after inline confirmation', async () => {
    render(<MobileAccessSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /mobileAccess.start/ }));

    expect(screen.getByText('mobileAccess.lanConfirm')).toBeInTheDocument();
    expect(bridgeMocks.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.confirmLanStart/ }));

    await waitFor(() => {
      expect(bridgeMocks.start).toHaveBeenCalledWith('0.0.0.0');
    });
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith('0.0.0.0');
  });

  it('uses a publish-host override for pairing without changing the bind host', async () => {
    render(<MobileAccessSettings />);

    fireEvent.change(await screen.findByLabelText('mobileAccess.publishHost.label'), {
      target: { value: 'phone.threadterm.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.start/ }));
    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.confirmLanStart/ }));

    await waitFor(() => {
      expect(bridgeMocks.start).toHaveBeenCalledWith('0.0.0.0');
    });
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith('phone.threadterm.test');
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
    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.confirmLanStart/ }));

    expect(start).toBeDisabled();

    resolveStart({
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://192.168.1.67:5174',
    });

    await waitFor(() => {
      expect(start).not.toBeDisabled();
    });
  });

  it('shows the bridge as running even when pair code creation fails', async () => {
    bridgeMocks.pairQr.mockRejectedValue(new Error('pair code failed'));

    render(<MobileAccessSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /mobileAccess.start/ }));
    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.confirmLanStart/ }));

    await waitFor(() => {
      expect(screen.getByText('mobileAccess.running')).toBeInTheDocument();
    });
    expect(screen.getByText('0.0.0.0:5174')).toBeInTheDocument();
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
    expect(screen.getByText(readOnlyPairUrl)).toBeInTheDocument();
    expect(screen.getByTestId('pair-qr-code')).toHaveAttribute('data-value', readOnlyPairUrl);
  });

  it('warns when a LAN pair code falls back to loopback without a publish host', async () => {
    bridgeMocks.status.mockResolvedValue({
      running: true,
      host: '0.0.0.0',
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

    render(<MobileAccessSettings />);

    expect(await screen.findByText('mobileAccess.publishHost.loopbackWarning')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:5174')).toBeInTheDocument();
  });

  it('still shows a pair code when loading devices fails after start', async () => {
    bridgeMocks.devices
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('devices failed'));

    render(<MobileAccessSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /mobileAccess.start/ }));
    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.confirmLanStart/ }));

    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(screen.getByText(readOnlyPairUrl)).toBeInTheDocument();
    expect(screen.getByText('mobileAccess.running')).toBeInTheDocument();
  });

  it('adds selected pairing permission to the mobile URL', async () => {
    bridgeMocks.status.mockResolvedValue({
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://192.168.1.67:5174',
    });

    render(<MobileAccessSettings />);

    expect(await screen.findByText(readOnlyPairUrl)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));

    expect(screen.getByText(fullPairUrl)).toBeInTheDocument();
    expect(screen.getByTestId('pair-qr-code')).toHaveAttribute('data-value', fullPairUrl);
  });
});
