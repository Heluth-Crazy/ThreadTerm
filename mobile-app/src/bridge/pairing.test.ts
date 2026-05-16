import { beforeEach, describe, expect, it } from 'vitest';
import {
  PERMISSION_KEY,
  TOKEN_KEY,
  readPairingConfig,
  storePairing,
} from './pairing';

function locationFor(search: string): Location {
  return new URL(`http://127.0.0.1:5174/pair${search}`) as unknown as Location;
}

describe('mobile bridge pairing', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reuses the existing bridge token keys so old paired devices reconnect', () => {
    window.localStorage.setItem(TOKEN_KEY, 'old-token');
    window.localStorage.setItem(PERMISSION_KEY, 'full');

    const config = readPairingConfig(locationFor(''));

    expect(config.storedToken).toBe('old-token');
    expect(config.permission).toBe('full');
  });

  it('does not let a stored full permission upgrade a read-only QR pairing', () => {
    window.localStorage.setItem(TOKEN_KEY, 'old-token');
    window.localStorage.setItem(PERMISSION_KEY, 'full');

    const config = readPairingConfig(locationFor('?otp=123456&permission=read_only'));

    expect(config.otp).toBe('123456');
    expect(config.permission).toBe('read_only');
    expect(config.storedToken).toBeNull();
  });

  it('migrates the short-lived mobile-app key names back to the bridge key names', () => {
    window.localStorage.setItem('threadterm.mobile.deviceToken', 'mobile-token');
    window.localStorage.setItem('threadterm.mobile.permission', 'full');

    expect(readPairingConfig(locationFor('')).storedToken).toBe('mobile-token');

    storePairing(
      {
        deviceToken: 'new-token',
        expiresInSeconds: 3600,
        device: {
          id: 'device-1',
          name: 'iPhone',
          permission: 'read_only',
          createdAt: 1,
        },
      },
      'iPhone',
    );

    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('new-token');
    expect(window.localStorage.getItem('threadterm.mobile.deviceToken')).toBeNull();
  });
});
