import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';

export const TOKEN_KEY = 'threadterm.bridgeToken';
export const PERMISSION_KEY = 'threadterm.bridgePermission';
export const DEVICE_NAME_KEY = 'threadterm.mobile.deviceName';
const LEGACY_TOKEN_KEY = 'threadterm.mobile.deviceToken';
const LEGACY_PERMISSION_KEY = 'threadterm.mobile.permission';

export interface PairingConfig {
  otp: string;
  permission: BridgeDevicePermission;
  storedToken: string | null;
  deviceName: string;
}

export interface PairResponse {
  deviceToken: string;
  expiresInSeconds: number;
  device: {
    id: string;
    name: string;
    permission: BridgeDevicePermission;
    createdAt: number;
    lastSeenAt?: number | null;
  };
}

export function readPairingConfig(location: Location, storage: Storage = window.localStorage): PairingConfig {
  const params = new URLSearchParams(location.search);
  const queryPermission = params.get('permission') === 'full' ? 'full' : 'read_only';
  const storedPermission = storage.getItem(PERMISSION_KEY) ?? storage.getItem(LEGACY_PERMISSION_KEY);
  const hasPairingCode = params.has('otp');
  const storedToken = storage.getItem(TOKEN_KEY) ?? storage.getItem(LEGACY_TOKEN_KEY);

  return {
    otp: params.get('otp') ?? '',
    permission: hasPairingCode
      ? queryPermission
      : storedPermission === 'full'
        ? 'full'
        : 'read_only',
    storedToken: hasPairingCode ? null : storedToken,
    deviceName: storage.getItem(DEVICE_NAME_KEY) || defaultDeviceName(),
  };
}

export async function pairDevice(
  otp: string,
  deviceName: string,
  permission: BridgeDevicePermission,
  fetcher: typeof fetch = fetch,
): Promise<PairResponse> {
  const response = await fetcher('/pair', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      otp,
      deviceName,
      permission,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as PairResponse;
}

export function storePairing(
  result: PairResponse,
  deviceName: string,
  storage: Storage = window.localStorage,
) {
  storage.setItem(TOKEN_KEY, result.deviceToken);
  storage.setItem(PERMISSION_KEY, result.device.permission);
  storage.setItem(DEVICE_NAME_KEY, deviceName);
  storage.removeItem(LEGACY_TOKEN_KEY);
  storage.removeItem(LEGACY_PERMISSION_KEY);
}

export function scrubPairingCodeFromUrl(history: History = window.history, location: Location = window.location) {
  const url = new URL(location.href);
  if (!url.searchParams.has('otp')) return;
  url.searchParams.delete('otp');
  history.replaceState({}, '', url.toString());
}

function defaultDeviceName(): string {
  const platform = navigator.userAgent.includes('Android')
    ? 'Android'
    : /iPhone|iPad|iPod/.test(navigator.userAgent)
      ? 'iOS'
      : 'Mobile';
  return `ThreadTerm ${platform}`;
}
