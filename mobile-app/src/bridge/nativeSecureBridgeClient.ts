/**
 * NativeSecureBridgeClient — secure workspace v2 transport.
 *
 * Production path (macOS/iOS only):
 *   Tauri plugin → URLSessionWebSocketTask + cert fingerprint pin + Keychain token.
 *
 * This module ships the TypeScript contract and a MockNativeSecurePlugin for
 * unit tests. Real Keychain/URLSession code lives in the iOS plugin (see
 * mobile-app/src-tauri/README.md) and cannot run on Windows.
 */

import type { ClientCommand, ServerMessage } from '@shared/mobile/bridge/protocol';
import { BRIDGE_PROTOCOL_VERSION } from '@shared/mobile/bridge/protocol';
import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';
import {
  assertFingerprintBeforeCredentials,
  FingerprintMismatchError,
} from './fingerprint';
import {
  mapV1CommandToV2,
  parseSecurePairQrPayload,
  parseV2ServerMessage,
  PROTOCOL_VERSION_V2,
  type SecurePairQrPayload,
  type V2ClientMessage,
  type V2ServerMessage,
  withV2ProtocolVersion,
} from './secureProtocol';
import {
  SECURE_WORKSPACE_CAPABILITIES,
  type BridgeCapability,
  type BridgeClient,
  type BridgeClientHandlers,
  type BridgeClientInfo,
  type BridgeClientKind,
  type BridgeTerminalState,
  type NativeSecureBridgeClientOptions,
  type NativeSecurePlugin,
} from './types';

export class NativeSecureBridgeClient implements BridgeClient {
  readonly kind: BridgeClientKind = 'native_secure';

  private permission: BridgeDevicePermission;
  private computerId: string | null;
  private computerLabel: string | null;
  private fingerprint: string | null;
  private endpoint: string | null;
  private status: BridgeTerminalState = 'idle';
  private handlers: BridgeClientHandlers = {};
  private plugin: NativeSecurePlugin;
  private secureReady = false;
  private authenticated = false;

  constructor(options: NativeSecureBridgeClientOptions = {}) {
    this.plugin = options.plugin ?? createUnavailableNativePlugin();
    this.permission = options.permission ?? 'read_only';
    this.computerId = options.computerId ?? options.qr?.computerId ?? null;
    this.computerLabel = options.computerLabel ?? null;
    this.fingerprint = options.fingerprint ?? options.qr?.fingerprint ?? null;
    this.endpoint = options.endpoint ?? options.qr?.endpoint ?? null;
  }

  getInfo(): BridgeClientInfo {
    return {
      kind: this.kind,
      capabilities: this.secureReady ? SECURE_WORKSPACE_CAPABILITIES : ['terminal'],
      permission: this.permission,
      computerId: this.computerId,
      computerLabel: this.computerLabel,
      secureWorkspaceReady: this.secureReady && this.authenticated,
    };
  }

  hasCapability(capability: BridgeCapability): boolean {
    return this.getInfo().capabilities.includes(capability);
  }

  getStatus(): BridgeTerminalState {
    return this.status;
  }

  /**
   * Validate QR structure/fingerprint format before any network use.
   * Does not open a socket and never exposes tokens.
   */
  validateQr(raw: unknown): SecurePairQrPayload {
    const payload = this.plugin.validateQr
      ? this.plugin.validateQr(raw)
      : parseSecurePairQrPayload(raw);
    this.computerId = payload.computerId;
    this.fingerprint = payload.fingerprint;
    this.endpoint = payload.endpoint;
    if (payload.maxPermission) this.permission = payload.maxPermission;
    return payload;
  }

  /**
   * Pair against the desktop. Fingerprint is verified by the native plugin
   * (or mock) before OTP is sent. Token stays in Keychain / mock vault.
   */
  async pair(input: {
    otp: string;
    deviceName: string;
    permission?: BridgeDevicePermission;
    computerId: string;
    fingerprint: string;
    endpoint: string;
    /** Presented leaf cert fingerprint (native TLS challenge). */
    presentedFingerprint: string;
  }): Promise<void> {
    assertFingerprintBeforeCredentials(input.fingerprint, input.presentedFingerprint);
    if (input.computerId !== this.computerId && this.computerId) {
      throw new Error('computerId does not match the scanned pairing identity.');
    }
    const result = await this.plugin.pair({
      otp: input.otp,
      deviceName: input.deviceName,
      permission: input.permission,
      computerId: input.computerId,
      fingerprint: input.fingerprint,
      endpoint: input.endpoint,
    });
    this.computerId = result.computerId;
    this.permission = result.permission;
    this.fingerprint = input.fingerprint;
    this.endpoint = input.endpoint;
    this.secureReady = true;
  }

  connect(handlers: BridgeClientHandlers): void {
    this.handlers = handlers;
    void this.connectAsync();
  }

  private async connectAsync(): Promise<void> {
    try {
      this.setStatus('connecting');
      await this.plugin.connect({
        onStatusChange: (status) => {
          this.setStatus(status);
          if (status === 'open') {
            this.authenticated = true;
            this.secureReady = true;
          }
          if (
            status === 'revoked' ||
            status === 'fingerprint_mismatch' ||
            status === 'protocol_incompatible' ||
            status === 'expired'
          ) {
            this.authenticated = false;
          }
        },
        onMessage: (raw) => this.dispatchRaw(raw),
        onError: (message) => this.handlers.onError?.(message),
      });
    } catch (error) {
      if (error instanceof FingerprintMismatchError) {
        this.setStatus('fingerprint_mismatch');
        this.handlers.onError?.(error.message);
        return;
      }
      this.setStatus('error');
      this.handlers.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  disconnect(): void {
    void this.plugin.disconnect();
    this.authenticated = false;
    if (
      this.status !== 'revoked' &&
      this.status !== 'fingerprint_mismatch' &&
      this.status !== 'protocol_incompatible' &&
      this.status !== 'expired'
    ) {
      this.setStatus('closed');
    }
  }

  send(command: ClientCommand): void {
    const mapped = mapV1CommandToV2(command);
    if (!mapped) {
      throw new Error(
        `Secure client cannot map v1 command "${command.kind}" without a workspace request id.`,
      );
    }
    this.sendV2(mapped);
  }

  sendV2(command: V2ClientMessage): void {
    const envelope = withV2ProtocolVersion(command);
    void this.plugin.send(JSON.stringify(envelope)).catch((error: unknown) => {
      this.handlers.onError?.(error instanceof Error ? error.message : String(error));
    });
  }

  async forgetPairing(): Promise<void> {
    await this.plugin.forget();
    this.authenticated = false;
    this.secureReady = false;
    this.computerId = null;
    this.fingerprint = null;
    this.endpoint = null;
    this.disconnect();
    this.setStatus('idle');
  }

  private dispatchRaw(raw: string): void {
    try {
      // Prefer v2 parse; fall back to v1-shaped terminal frames if needed.
      if (raw.includes('"protocol_version":2') || raw.includes('"protocol_version": 2')) {
        const message = parseV2ServerMessage(raw);
        this.handleV2(message);
        return;
      }
      const parsed = JSON.parse(raw) as ServerMessage;
      if (parsed.protocol_version === BRIDGE_PROTOCOL_VERSION) {
        this.handlers.onMessage?.(parsed);
        return;
      }
      // Attempt v2 anyway.
      const message = parseV2ServerMessage(raw);
      this.handleV2(message);
    } catch (error) {
      this.handlers.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  private handleV2(message: V2ServerMessage): void {
    if (message.kind === 'revoked') {
      this.authenticated = false;
      this.setStatus('revoked');
    }
    if (message.kind === 'error' && message.code === 'protocol_version_mismatch') {
      this.setStatus('protocol_incompatible');
    }
    if (message.kind === 'auth_ok') {
      this.authenticated = true;
      this.secureReady = true;
      this.computerId = message.computer_id;
      this.permission = message.device.permission;
      this.setStatus('open');
    }
    // Terminal frames also surface through the shared v1 message path so
    // terminalFeed/MainTerminal stay byte-compatible.
    if (message.kind === 'terminal_output') {
      this.handlers.onMessage?.({
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        kind: 'terminal_output',
        card_id: message.card_id,
        data: message.data,
        seq: message.seq,
        runtimeId: message.runtimeId,
        streamSeq: message.streamSeq,
      } as ServerMessage);
    } else if (message.kind === 'terminal_snapshot') {
      this.handlers.onMessage?.({
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        kind: 'terminal_snapshot',
        snapshot: {
          cardId: message.cardId,
          data: message.data,
          seq: message.seq,
          runtimeId: message.runtimeId,
          streamSeq: message.streamSeq,
          rows: message.rows,
          cols: message.cols,
          cursorRow: message.cursorRow,
          cursorCol: message.cursorCol,
          history: message.history,
        },
      });
    }
    this.handlers.onV2Message?.(message);
  }

  private setStatus(status: BridgeTerminalState): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatusChange?.(status);
  }
}

function createUnavailableNativePlugin(): NativeSecurePlugin {
  const fail = async (): Promise<never> => {
    throw new Error(
      'Native secure bridge plugin is only available on iOS/macOS with the Tauri secure plugin. Use MockNativeSecurePlugin in tests.',
    );
  };
  return {
    validateQr: parseSecurePairQrPayload,
    pair: () => fail(),
    connect: () => fail(),
    disconnect: async () => undefined,
    send: () => fail(),
    forget: async () => undefined,
    hasStoredToken: async () => false,
    getStoredComputerMeta: async () => null,
  };
}

/** In-memory mock for unit tests — never persists source text. */
export class MockNativeSecurePlugin implements NativeSecurePlugin {
  private token: string | null = null;
  private meta: {
    computerId: string;
    computerLabel: string | null;
    fingerprint: string;
    endpoint: string;
    permission: BridgeDevicePermission;
  } | null = null;
  private handlers: {
    onStatusChange: (status: BridgeTerminalState) => void;
    onMessage: (raw: string) => void;
    onError: (message: string) => void;
  } | null = null;
  private open = false;
  /** Optional hook to assert credentials are not sent before pin check. */
  credentialsSent = false;
  presentedFingerprint: string | null = null;
  /** When set, pair() verifies against this before accepting OTP. */
  requirePresentedFingerprint: string | null = null;

  validateQr(payload: unknown): SecurePairQrPayload {
    return parseSecurePairQrPayload(payload);
  }

  async pair(request: {
    otp: string;
    deviceName: string;
    permission?: BridgeDevicePermission;
    computerId: string;
    fingerprint: string;
    endpoint: string;
  }): Promise<{
    computerId: string;
    permission: BridgeDevicePermission;
    expiresInSeconds: number;
  }> {
    if (this.requirePresentedFingerprint) {
      assertFingerprintBeforeCredentials(
        request.fingerprint,
        this.requirePresentedFingerprint,
      );
    }
    this.credentialsSent = true;
    this.token = `mock-token:${request.otp}`;
    this.meta = {
      computerId: request.computerId,
      computerLabel: request.deviceName,
      fingerprint: request.fingerprint,
      endpoint: request.endpoint,
      permission: request.permission === 'full' ? 'full' : 'read_only',
    };
    return {
      computerId: request.computerId,
      permission: this.meta.permission,
      expiresInSeconds: 3600,
    };
  }

  async connect(handlers: {
    onStatusChange: (status: BridgeTerminalState) => void;
    onMessage: (raw: string) => void;
    onError: (message: string) => void;
  }): Promise<void> {
    this.handlers = handlers;
    if (!this.token || !this.meta) {
      handlers.onError('No stored secure pairing token.');
      handlers.onStatusChange('error');
      return;
    }
    handlers.onStatusChange('connecting');
    this.open = true;
    handlers.onStatusChange('open');
    handlers.onMessage(
      JSON.stringify({
        protocol_version: PROTOCOL_VERSION_V2,
        kind: 'auth_ok',
        device: {
          id: 'mock-device',
          name: this.meta.computerLabel ?? 'Mock',
          permission: this.meta.permission,
          createdAt: Date.now(),
        },
        computer_id: this.meta.computerId,
        serverId: this.meta.computerId,
        runtimeId: 'mock-runtime',
      }),
    );
  }

  async disconnect(): Promise<void> {
    this.open = false;
    this.handlers?.onStatusChange('closed');
  }

  async send(raw: string): Promise<void> {
    if (!this.open) throw new Error('Mock secure socket is not open');
    // Echo pong for ping.
    try {
      const parsed = JSON.parse(raw) as { kind?: string; t?: number };
      if (parsed.kind === 'ping') {
        this.handlers?.onMessage(
          JSON.stringify({
            protocol_version: PROTOCOL_VERSION_V2,
            kind: 'pong',
            t: parsed.t ?? Date.now(),
          }),
        );
      }
    } catch {
      // ignore
    }
  }

  async forget(): Promise<void> {
    this.token = null;
    this.meta = null;
    this.credentialsSent = false;
    this.open = false;
  }

  async hasStoredToken(): Promise<boolean> {
    return Boolean(this.token);
  }

  async getStoredComputerMeta() {
    return this.meta;
  }

  /** Test helper: inject a server message. */
  emit(message: V2ServerMessage | Record<string, unknown>): void {
    const body =
      'protocol_version' in message
        ? message
        : { protocol_version: PROTOCOL_VERSION_V2, ...message };
    this.handlers?.onMessage(JSON.stringify(body));
  }
}

export function createNativeSecureBridgeClient(
  options: NativeSecureBridgeClientOptions = {},
): NativeSecureBridgeClient {
  return new NativeSecureBridgeClient(options);
}
