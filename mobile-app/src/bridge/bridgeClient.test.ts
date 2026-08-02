import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LegacyWebBridgeClient } from './legacyWebBridgeClient';
import {
  MockNativeSecurePlugin,
  NativeSecureBridgeClient,
} from './nativeSecureBridgeClient';
import {
  parseSecurePairQrPayload,
  PROTOCOL_VERSION_V2,
  isV1ForbiddenWorkspaceKind,
} from './secureProtocol';
import {
  assertFingerprintBeforeCredentials,
  FingerprintMismatchError,
  fingerprintsMatch,
  sha256HexOfDer,
} from './fingerprint';
import { canPerformAction } from './permissions';
import {
  assertNoSourcePersistence,
  auditBrowserStorage,
  looksLikeSourcePayload,
} from './storageGuard';
import { LEGACY_CAPABILITIES, SECURE_WORKSPACE_CAPABILITIES } from './types';

const VALID_FP = 'ab'.repeat(32);

const sampleQr = {
  protocol: PROTOCOL_VERSION_V2,
  host: '192.168.1.10',
  port: 17890,
  otp: 'otp-123',
  computerId: 'computer-a',
  fingerprint: VALID_FP,
  endpoint: 'wss://192.168.1.10:17890',
  maxPermission: 'full' as const,
};

describe('secure protocol QR validation', () => {
  it('accepts a well-formed v2 QR payload', () => {
    const parsed = parseSecurePairQrPayload(sampleQr);
    expect(parsed.computerId).toBe('computer-a');
    expect(parsed.fingerprint).toBe(VALID_FP);
    expect(parsed.endpoint).toMatch(/^wss:\/\//);
  });

  it('rejects protocol 1 and invalid fingerprints before networking', () => {
    expect(() =>
      parseSecurePairQrPayload({ ...sampleQr, protocol: 1 }),
    ).toThrow(/protocol 2/i);
    expect(() =>
      parseSecurePairQrPayload({ ...sampleQr, fingerprint: 'deadbeef' }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      parseSecurePairQrPayload({ ...sampleQr, endpoint: 'ws://x' }),
    ).toThrow(/wss/i);
  });

  it('lists workspace kinds forbidden on plaintext v1', () => {
    expect(isV1ForbiddenWorkspaceKind('read_file')).toBe(true);
    expect(isV1ForbiddenWorkspaceKind('input')).toBe(false);
  });
});

describe('fingerprint helpers', () => {
  it('matches normalized hex fingerprints', () => {
    expect(fingerprintsMatch(VALID_FP, VALID_FP.toUpperCase())).toBe(true);
    expect(fingerprintsMatch(VALID_FP, 'cd'.repeat(32))).toBe(false);
  });

  it('refuses credentials when fingerprint mismatches', () => {
    expect(() =>
      assertFingerprintBeforeCredentials(VALID_FP, 'cd'.repeat(32)),
    ).toThrow(FingerprintMismatchError);
  });

  it('hashes DER bytes with Web Crypto when available', async () => {
    if (!globalThis.crypto?.subtle) return;
    const der = new Uint8Array([1, 2, 3, 4, 5]);
    const hex = await sha256HexOfDer(der);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('LegacyWebBridgeClient', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advertises terminal-only capability and refuses workspace v2 sends', () => {
    const client = new LegacyWebBridgeClient({
      baseUrl: 'http://127.0.0.1:5175',
      token: 'tok',
      permission: 'full',
    });
    expect(client.kind).toBe('legacy_web');
    expect(client.hasCapability('terminal')).toBe(true);
    expect(client.hasCapability('files')).toBe(false);
    expect(client.getInfo().capabilities).toEqual([...LEGACY_CAPABILITIES]);
    expect(() =>
      client.sendV2({
        kind: 'read_file',
        request_id: 'r1',
        workspace_id: 'w',
        relative_path: 'a.ts',
      }),
    ).toThrow(/secure/i);
  });
});

describe('NativeSecureBridgeClient + mock plugin', () => {
  it('pairs only after fingerprint match and never exposes token to JS', async () => {
    const plugin = new MockNativeSecurePlugin();
    plugin.requirePresentedFingerprint = VALID_FP;
    const client = new NativeSecureBridgeClient({ plugin, qr: sampleQr });

    await expect(
      client.pair({
        otp: sampleQr.otp,
        deviceName: 'iPhone',
        permission: 'full',
        computerId: sampleQr.computerId,
        fingerprint: sampleQr.fingerprint,
        endpoint: sampleQr.endpoint,
        presentedFingerprint: 'cd'.repeat(32),
      }),
    ).rejects.toBeInstanceOf(FingerprintMismatchError);
    expect(plugin.credentialsSent).toBe(false);

    await client.pair({
      otp: sampleQr.otp,
      deviceName: 'iPhone',
      permission: 'full',
      computerId: sampleQr.computerId,
      fingerprint: sampleQr.fingerprint,
      endpoint: sampleQr.endpoint,
      presentedFingerprint: VALID_FP,
    });
    expect(plugin.credentialsSent).toBe(true);
    expect(await plugin.hasStoredToken()).toBe(true);
    // Token is not part of getInfo / public fields
    expect(JSON.stringify(client.getInfo())).not.toMatch(/mock-token/);

    const statuses: string[] = [];
    const v2: string[] = [];
    client.connect({
      onStatusChange: (s) => statuses.push(String(s)),
      onV2Message: (m) => v2.push(m.kind),
    });
    await vi.waitFor(() => expect(statuses).toContain('open'));
    expect(client.getInfo().secureWorkspaceReady).toBe(true);
    expect(client.getInfo().capabilities).toEqual([...SECURE_WORKSPACE_CAPABILITIES]);
    expect(v2).toContain('auth_ok');

    await client.forgetPairing();
    expect(await plugin.hasStoredToken()).toBe(false);
    expect(client.getInfo().secureWorkspaceReady).toBe(false);
  });
});

describe('permission matrix', () => {
  const fullSecure = {
    permission: 'full' as const,
    capabilities: [...SECURE_WORKSPACE_CAPABILITIES],
    secureWorkspaceReady: true,
  };
  const readOnlySecure = {
    permission: 'read_only' as const,
    capabilities: [...SECURE_WORKSPACE_CAPABILITIES],
    secureWorkspaceReady: true,
  };
  const legacy = {
    permission: 'full' as const,
    capabilities: [...LEGACY_CAPABILITIES],
    secureWorkspaceReady: false,
  };

  it('allows read-only clean tab ops and blocks mutations', () => {
    expect(canPerformAction(readOnlySecure, 'close_clean_tab').allowed).toBe(true);
    expect(canPerformAction(readOnlySecure, 'set_active_tab').allowed).toBe(true);
    expect(canPerformAction(readOnlySecure, 'terminal_end').allowed).toBe(false);
    expect(canPerformAction(readOnlySecure, 'file_save').allowed).toBe(false);
    expect(canPerformAction(readOnlySecure, 'lease_takeover').allowed).toBe(false);
  });

  it('blocks dirty close save for read-only', () => {
    const result = canPerformAction(readOnlySecure, 'close_clean_tab', { dirty: true });
    expect(result.allowed).toBe(false);
  });

  it('blocks file ops on legacy terminal-only client even with full permission', () => {
    expect(canPerformAction(legacy, 'open_file').allowed).toBe(false);
    expect(canPerformAction(legacy, 'file_edit').allowed).toBe(false);
    expect(canPerformAction(fullSecure, 'file_edit').allowed).toBe(true);
  });

  it('disables mutations while offline', () => {
    expect(
      canPerformAction(fullSecure, 'file_save', { connectionOpen: false }).allowed,
    ).toBe(false);
  });
});

describe('no localStorage of source', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('detects multi-line source-like payloads', () => {
    const source = [
      'export function foo() {',
      '  return 1;',
      '}',
      '// padding to exceed heuristic size threshold for source bodies',
      'const more = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";',
    ].join('\n');
    expect(looksLikeSourcePayload(source)).toBe(true);
    expect(looksLikeSourcePayload('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n')).toBe(true);
    expect(looksLikeSourcePayload('zh')).toBe(false);
  });

  it('refuses forbidden keys and audits storage', () => {
    expect(() =>
      assertNoSourcePersistence(
        'threadterm.mobile.draft',
        'function x(){\nreturn 1\n}\n// more\n// lines',
      ),
    ).toThrow();
    window.localStorage.setItem('threadterm.mobile.deviceName', 'iPhone');
    window.localStorage.setItem(
      'evil.source.cache',
      ['a', 'b', 'c', 'd', 'e'].join('\n') + 'x'.repeat(200),
    );
    const findings = auditBrowserStorage();
    expect(findings.some((f) => f.key === 'evil.source.cache')).toBe(true);
    expect(findings.some((f) => f.key === 'threadterm.mobile.deviceName')).toBe(false);
  });
});
