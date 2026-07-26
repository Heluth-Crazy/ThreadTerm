import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';

export const TOKEN_KEY = 'threadterm.bridgeToken';
export const PERMISSION_KEY = 'threadterm.bridgePermission';
export const SERVER_ID_KEY = 'threadterm.bridgeServerId';
export const DEVICE_NAME_KEY = 'threadterm.mobile.deviceName';
const LEGACY_TOKEN_KEY = 'threadterm.mobile.deviceToken';
const LEGACY_PERMISSION_KEY = 'threadterm.mobile.permission';

export interface PairingConfig {
  otp: string;
  permission: BridgeDevicePermission;
  storedToken: string | null;
  serverId: string;
  deviceName: string;
}

export interface PairResponse {
  deviceToken: string;
  serverId: string;
  expiresInSeconds: number;
  device: {
    id: string;
    name: string;
    permission: BridgeDevicePermission;
    createdAt: number;
    lastSeenAt?: number | null;
  };
}

export function readPairingConfig(
  location: Location,
  sessionStorage: Storage = window.sessionStorage,
  durableStorage: Storage = window.localStorage,
): PairingConfig {
  const params = new URLSearchParams(location.search);
  const queryPermission = params.get('permission') === 'full' ? 'full' : 'read_only';
  const storedPermission = sessionStorage.getItem(PERMISSION_KEY);
  const hasPairingCode = params.has('otp');
  const storedToken = sessionStorage.getItem(TOKEN_KEY);
  const serverId = hasPairingCode
    ? params.get('server_id') ?? ''
    : sessionStorage.getItem(SERVER_ID_KEY) ?? '';

  // Device credentials used to survive browser restarts in localStorage.
  // That legacy behavior is intentionally retired: keep only the non-secret
  // device label and require a fresh QR after the browser session ends.
  durableStorage.removeItem(TOKEN_KEY);
  durableStorage.removeItem(PERMISSION_KEY);
  durableStorage.removeItem(SERVER_ID_KEY);
  durableStorage.removeItem(LEGACY_TOKEN_KEY);
  durableStorage.removeItem(LEGACY_PERMISSION_KEY);

  return {
    otp: params.get('otp') ?? '',
    permission: hasPairingCode
      ? queryPermission
      : storedPermission === 'full'
        ? 'full'
        : 'read_only',
    storedToken: hasPairingCode || !serverId ? null : storedToken,
    serverId,
    deviceName: durableStorage.getItem(DEVICE_NAME_KEY) || defaultDeviceName(),
  };
}

export async function pairDevice(
  otp: string,
  deviceName: string,
  permission: BridgeDevicePermission,
  serverId: string,
  fetcher: typeof fetch = fetch,
): Promise<PairResponse> {
  if (!serverId) {
    throw new Error('Pairing link is missing the computer identity.');
  }
  const response = await fetcher('/pair', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      otp,
      deviceName,
      permission,
      serverId,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const result = (await response.json()) as PairResponse;
  if (!result.serverId || result.serverId !== serverId) {
    throw new Error('The connected computer does not match this pairing code.');
  }
  return result;
}

export function storePairing(
  result: PairResponse,
  deviceName: string,
  sessionStorage: Storage = window.sessionStorage,
  durableStorage: Storage = window.localStorage,
) {
  sessionStorage.setItem(TOKEN_KEY, result.deviceToken);
  sessionStorage.setItem(PERMISSION_KEY, result.device.permission);
  sessionStorage.setItem(SERVER_ID_KEY, result.serverId);
  durableStorage.setItem(DEVICE_NAME_KEY, deviceName);
  durableStorage.removeItem(TOKEN_KEY);
  durableStorage.removeItem(PERMISSION_KEY);
  durableStorage.removeItem(SERVER_ID_KEY);
  durableStorage.removeItem(LEGACY_TOKEN_KEY);
  durableStorage.removeItem(LEGACY_PERMISSION_KEY);
}

export function clearPairingStorage(
  sessionStorage: Storage = window.sessionStorage,
  durableStorage: Storage = window.localStorage,
) {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PERMISSION_KEY);
  sessionStorage.removeItem(SERVER_ID_KEY);
  durableStorage.removeItem(TOKEN_KEY);
  durableStorage.removeItem(PERMISSION_KEY);
  durableStorage.removeItem(SERVER_ID_KEY);
  durableStorage.removeItem(LEGACY_TOKEN_KEY);
  durableStorage.removeItem(LEGACY_PERMISSION_KEY);
}

export function scrubPairingCodeFromUrl(history: History = window.history, location: Location = window.location) {
  const url = new URL(location.href);
  if (!url.searchParams.has('otp')) return;
  url.searchParams.delete('otp');
  url.searchParams.delete('server_id');
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
