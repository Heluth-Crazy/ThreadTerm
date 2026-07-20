import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../../theme/ThemeContext', () => ({
  useTheme: () => themeMocks,
}));

const readOnlyPairUrl =
  'http://192.168.1.67:5174/pair?otp=123456&permission=read_only&theme_bg=%2310151d&theme_card=%23151b24&theme_primary=%234f8bd6&theme_fg=%23e8edf5&lang=en';

const fullPairUrl =
  'http://192.168.1.67:5174/pair?otp=123456&permission=full&theme_bg=%2310151d&theme_card=%23151b24&theme_primary=%234f8bd6&theme_fg=%23e8edf5&lang=en';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function pairResponse(otp: string) {
  return {
    host: '192.168.1.67',
    port: 5174,
    otp,
    url: `http://192.168.1.67:5174/pair?otp=${otp}`,
    expiresInSeconds: 300,
  };
}

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

  it('shows a clear QR placeholder before the bridge starts', async () => {
    render(<MobileAccessSettings />);

    expect(await screen.findByText('mobileAccess.pairingStoppedTitle')).toBeInTheDocument();
    expect(screen.getByText('mobileAccess.pairingStoppedDescription')).toBeInTheDocument();
    expect(screen.queryByTestId('pair-qr-code')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'mobileAccess.pairingStart' }),
    );

    expect(screen.getByText('mobileAccess.lanConfirm')).toBeInTheDocument();
    expect(bridgeMocks.start).not.toHaveBeenCalled();
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
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith('0.0.0.0', 'read_only');
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
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith(
      'phone.threadterm.test',
      'read_only',
    );
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
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith('0.0.0.0', 'read_only');
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
    expect(screen.getByText('mobileAccess.pairingUnavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('pair-qr-code')).not.toBeInTheDocument();
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
      expect(bridgeMocks.pairQr).toHaveBeenCalledWith('0.0.0.0', 'read_only');
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

  it('requests a new server-bound pairing code when permission changes', async () => {
    bridgeMocks.status.mockResolvedValue({
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://192.168.1.67:5174',
    });

    render(<MobileAccessSettings />);

    expect(await screen.findByText(readOnlyPairUrl)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));

    expect(await screen.findByText(fullPairUrl)).toBeInTheDocument();
    expect(screen.getByTestId('pair-qr-code')).toHaveAttribute('data-value', fullPairUrl);
    expect(bridgeMocks.pairQr).toHaveBeenLastCalledWith('0.0.0.0', 'full');
  });

  it('hides the previous code when a permission-bound refresh fails', async () => {
    bridgeMocks.status.mockResolvedValue({
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://192.168.1.67:5174',
    });

    render(<MobileAccessSettings />);
    expect(await screen.findByText(readOnlyPairUrl)).toBeInTheDocument();

    bridgeMocks.pairQr.mockRejectedValueOnce(new Error('permission refresh failed'));
    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));

    expect(await screen.findByText('mobileAccess.error')).toBeInTheDocument();
    expect(screen.queryByText(readOnlyPairUrl)).not.toBeInTheDocument();
    expect(screen.queryByTestId('pair-qr-code')).not.toBeInTheDocument();
  });

  it('skips a stale refresh pairing request that has not started yet', async () => {
    const runningStatus = {
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://192.168.1.67:5174',
    };
    bridgeMocks.status.mockResolvedValue(runningStatus);

    render(<MobileAccessSettings />);
    expect(await screen.findByText(readOnlyPairUrl)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));
    expect(await screen.findByText(fullPairUrl)).toBeInTheDocument();

    const pendingStatus = deferred<typeof runningStatus>();
    bridgeMocks.status.mockReturnValueOnce(pendingStatus.promise);
    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.refresh/ }));
    await waitFor(() => {
      expect(bridgeMocks.status).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.read_only'));
    await waitFor(() => {
      expect(bridgeMocks.pairQr).toHaveBeenCalledTimes(3);
    });
    expect(bridgeMocks.pairQr).toHaveBeenLastCalledWith('0.0.0.0', 'read_only');

    await act(async () => {
      pendingStatus.resolve(runningStatus);
    });
    await waitFor(() => {
      expect(bridgeMocks.devices).toHaveBeenCalledTimes(2);
    });

    expect(bridgeMocks.pairQr).toHaveBeenCalledTimes(3);
    expect(screen.getByText(readOnlyPairUrl)).toBeInTheDocument();
    expect(screen.queryByText(fullPairUrl)).not.toBeInTheDocument();
  });

  it('serializes an in-flight full pairing request before the latest read-only request', async () => {
    const runningStatus = {
      running: true,
      host: '0.0.0.0',
      port: 5174,
      url: 'http://192.168.1.67:5174',
    };
    bridgeMocks.status.mockResolvedValue(runningStatus);

    render(<MobileAccessSettings />);
    expect(await screen.findByText(readOnlyPairUrl)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));
    expect(await screen.findByText(fullPairUrl)).toBeInTheDocument();

    const staleFullRequest = deferred<ReturnType<typeof pairResponse>>();
    const latestReadOnlyRequest = deferred<ReturnType<typeof pairResponse>>();
    bridgeMocks.pairQr
      .mockImplementationOnce(() => staleFullRequest.promise)
      .mockImplementationOnce(() => latestReadOnlyRequest.promise);

    fireEvent.click(screen.getByRole('button', { name: /mobileAccess.refresh/ }));
    await waitFor(() => {
      expect(bridgeMocks.pairQr).toHaveBeenCalledTimes(3);
    });
    expect(bridgeMocks.pairQr).toHaveBeenLastCalledWith('0.0.0.0', 'full');

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.read_only'));
    expect(bridgeMocks.pairQr).toHaveBeenCalledTimes(3);

    await act(async () => {
      staleFullRequest.reject(new Error('stale full request failed'));
    });
    await waitFor(() => {
      expect(bridgeMocks.pairQr).toHaveBeenCalledTimes(4);
    });
    expect(bridgeMocks.pairQr).toHaveBeenLastCalledWith('0.0.0.0', 'read_only');
    expect(screen.queryByText('mobileAccess.error')).not.toBeInTheDocument();
    expect(screen.queryByText('123456')).not.toBeInTheDocument();

    await act(async () => {
      latestReadOnlyRequest.resolve(pairResponse('654321'));
    });

    expect(await screen.findByText('654321')).toBeInTheDocument();
    expect(screen.queryByText('mobileAccess.error')).not.toBeInTheDocument();
    expect(screen.queryByText(fullPairUrl)).not.toBeInTheDocument();
    expect(screen.getByLabelText('mobileAccess.permissions.read_only')).toBeChecked();
  });
});
