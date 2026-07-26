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

const secureTunnelUrl = 'https://threadterm.example.ts.net';
const serverId = 'server-identity';

function expectedPairUrl(
  otp = '123456',
  permission: 'read_only' | 'full' = 'read_only',
) {
  return `${secureTunnelUrl}/pair?server_id=${serverId}&otp=${otp}&permission=${permission}&theme_bg=%2310151d&theme_card=%23151b24&theme_primary=%234f8bd6&theme_fg=%23e8edf5&lang=en`;
}

function pairResponse(
  otp: string,
  publicUrl?: string,
) {
  const secure = Boolean(publicUrl?.startsWith('https://'));
  const baseUrl = secure ? publicUrl : 'http://127.0.0.1:5174';
  return {
    host: secure ? 'threadterm.example.ts.net' : '127.0.0.1',
    port: secure ? 443 : 5174,
    otp,
    serverId,
    url: `${baseUrl}/pair?server_id=${serverId}&otp=${otp}`,
    expiresInSeconds: 300,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function startWithSecureTunnel() {
  fireEvent.change(await screen.findByLabelText('mobileAccess.publishHost.label'), {
    target: { value: secureTunnelUrl },
  });
  fireEvent.click(screen.getByRole('button', { name: /mobileAccess.start/ }));
  await screen.findByText(expectedPairUrl());
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
      host: '127.0.0.1',
      port: 5174,
      url: 'http://127.0.0.1:5174',
    });
    bridgeMocks.pairQr.mockImplementation(
      async (publicUrl?: string) => pairResponse('123456', publicUrl),
    );
  });

  it('starts locally but withholds the phone QR until an HTTPS tunnel is supplied', async () => {
    render(<MobileAccessSettings />);

    expect(
      await screen.findByText('mobileAccess.pairingStoppedTitle'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'mobileAccess.pairingStart' }),
    );

    await waitFor(() => {
      expect(bridgeMocks.start).toHaveBeenCalledWith('127.0.0.1');
    });
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith(undefined, 'read_only');
    expect(
      await screen.findByText('mobileAccess.publishHost.secureRequired'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('pair-qr-code')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'mobileAccess.copyUrl' }),
    ).toBeDisabled();
  });

  it('creates a phone-safe QR from a full HTTPS tunnel URL without changing the bind host', async () => {
    render(<MobileAccessSettings />);

    await startWithSecureTunnel();

    expect(bridgeMocks.start).toHaveBeenCalledWith('127.0.0.1');
    expect(bridgeMocks.pairQr).toHaveBeenCalledWith(
      secureTunnelUrl,
      'read_only',
    );
    expect(screen.getByTestId('pair-qr-code')).toHaveAttribute(
      'data-value',
      expectedPairUrl(),
    );
    expect(screen.getByText('127.0.0.1:5174')).toBeInTheDocument();
    expect(screen.getByText('threadterm.example.ts.net:443')).toBeInTheDocument();
  });

  it('disables the start control while startup is still running', async () => {
    const pendingStart = deferred<{
      running: boolean;
      host: string;
      port: number;
      url: string;
    }>();
    bridgeMocks.start.mockReturnValueOnce(pendingStart.promise);
    render(<MobileAccessSettings />);

    const start = await screen.findByRole('button', {
      name: /mobileAccess.start/,
    });
    fireEvent.click(start);
    expect(start).toBeDisabled();

    await act(async () => {
      pendingStart.resolve({
        running: true,
        host: '127.0.0.1',
        port: 5174,
        url: 'http://127.0.0.1:5174',
      });
    });
    await waitFor(() => expect(start).not.toBeDisabled());
  });

  it('keeps the service visibly running if pair-code creation fails', async () => {
    bridgeMocks.pairQr.mockRejectedValue(new Error('pair code failed'));
    render(<MobileAccessSettings />);

    fireEvent.click(
      await screen.findByRole('button', { name: /mobileAccess.start/ }),
    );

    expect(await screen.findByText('mobileAccess.running')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:5174')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /mobileAccess.newPairCode/ }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('pair-qr-code')).not.toBeInTheDocument();
  });

  it('keeps the secure pair code visible if loading the device list fails', async () => {
    bridgeMocks.devices
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('devices failed'));
    render(<MobileAccessSettings />);

    await startWithSecureTunnel();

    expect(screen.getByTestId('pair-qr-code')).toBeInTheDocument();
    expect(screen.getByText('mobileAccess.running')).toBeInTheDocument();
  });

  it('requests a new server-bound pairing code when permission changes', async () => {
    render(<MobileAccessSettings />);
    await startWithSecureTunnel();

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));

    expect(await screen.findByText(expectedPairUrl('123456', 'full'))).toBeInTheDocument();
    expect(bridgeMocks.pairQr).toHaveBeenLastCalledWith(
      secureTunnelUrl,
      'full',
    );
  });

  it('hides the previous code when a permission-bound refresh fails', async () => {
    render(<MobileAccessSettings />);
    await startWithSecureTunnel();

    bridgeMocks.pairQr.mockRejectedValueOnce(
      new Error('permission refresh failed'),
    );
    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));

    expect(await screen.findByText('mobileAccess.error')).toBeInTheDocument();
    expect(screen.queryByTestId('pair-qr-code')).not.toBeInTheDocument();
    expect(screen.queryByText(expectedPairUrl())).not.toBeInTheDocument();
  });

  it('does not let a stale refresh overwrite the latest permission', async () => {
    render(<MobileAccessSettings />);
    await startWithSecureTunnel();
    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.full'));
    await screen.findByText(expectedPairUrl('123456', 'full'));

    const runningStatus = {
      running: true,
      host: '127.0.0.1',
      port: 5174,
      url: 'http://127.0.0.1:5174',
    };
    const pendingStatus = deferred<typeof runningStatus>();
    bridgeMocks.status.mockReturnValueOnce(pendingStatus.promise);
    fireEvent.click(
      screen.getByRole('button', { name: /mobileAccess.refresh/ }),
    );
    await waitFor(() => expect(bridgeMocks.status).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByLabelText('mobileAccess.permissions.read_only'));
    await waitFor(() => expect(bridgeMocks.pairQr).toHaveBeenCalledTimes(3));
    expect(bridgeMocks.pairQr).toHaveBeenLastCalledWith(
      secureTunnelUrl,
      'read_only',
    );

    await act(async () => {
      pendingStatus.resolve(runningStatus);
    });
    await waitFor(() => expect(bridgeMocks.devices).toHaveBeenCalledTimes(3));

    expect(bridgeMocks.pairQr).toHaveBeenCalledTimes(3);
    expect(screen.getByText(expectedPairUrl())).toBeInTheDocument();
    expect(
      screen.queryByText(expectedPairUrl('123456', 'full')),
    ).not.toBeInTheDocument();
  });
});
