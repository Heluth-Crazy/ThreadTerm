import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_KEY,
  SERVER_ID_KEY,
  TOKEN_KEY,
  pairDevice,
  readPairingConfig,
  storePairing,
} from './pairing';

function locationFor(search: string): Location {
  return new URL(`http://127.0.0.1:5174/pair${search}`) as unknown as Location;
}

describe('mobile bridge pairing', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('reuses credentials only inside the current browser session', () => {
    window.sessionStorage.setItem(TOKEN_KEY, 'session-token');
    window.sessionStorage.setItem(PERMISSION_KEY, 'full');
    window.sessionStorage.setItem(SERVER_ID_KEY, 'computer-a');

    const config = readPairingConfig(locationFor(''));

    expect(config.storedToken).toBe('session-token');
    expect(config.permission).toBe('full');
    expect(config.serverId).toBe('computer-a');
  });

  it('deletes durable legacy credentials instead of silently reconnecting', () => {
    window.localStorage.setItem(TOKEN_KEY, 'old-token');
    window.localStorage.setItem(PERMISSION_KEY, 'full');

    const config = readPairingConfig(locationFor(''));

    expect(config.storedToken).toBeNull();
    expect(config.permission).toBe('read_only');
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(PERMISSION_KEY)).toBeNull();
  });

  it('does not let a session full permission upgrade a read-only QR pairing', () => {
    window.sessionStorage.setItem(TOKEN_KEY, 'old-token');
    window.sessionStorage.setItem(PERMISSION_KEY, 'full');
    window.sessionStorage.setItem(SERVER_ID_KEY, 'computer-old');

    const config = readPairingConfig(
      locationFor('?otp=pair-code&server_id=computer-new&permission=read_only'),
    );

    expect(config.otp).toBe('pair-code');
    expect(config.permission).toBe('read_only');
    expect(config.storedToken).toBeNull();
    expect(config.serverId).toBe('computer-new');
  });

  it('stores credentials in session storage and keeps only the device label durably', () => {

    storePairing(
      {
        deviceToken: 'new-token',
        serverId: 'computer-a',
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

    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe('new-token');
    expect(window.sessionStorage.getItem(SERVER_ID_KEY)).toBe('computer-a');
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem('threadterm.mobile.deviceName')).toBe('iPhone');
  });

  it('rejects a pairing response from a different computer identity', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          deviceToken: 'new-token',
          serverId: 'computer-b',
          expiresInSeconds: 3600,
          device: {
            id: 'device-1',
            name: 'iPhone',
            permission: 'read_only',
            createdAt: 1,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      pairDevice(
        'pair-code',
        'iPhone',
        'read_only',
        'computer-a',
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow(/does not match/i);
  });
});
