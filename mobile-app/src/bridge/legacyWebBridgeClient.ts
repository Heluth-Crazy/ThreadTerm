/**
 * LegacyWebBridgeClient — plaintext v1 terminal-only transport used by the
 * embedded mobile web bundle. Advertises terminal capability only; never
 * accepts workspace file/diff/draft commands.
 */

import type { ClientCommand, ServerMessage } from '@shared/mobile/bridge/protocol';
import {
  BridgeWsClient,
  type BridgeConnectionState,
  type BridgeTransportState,
} from '@shared/mobile/bridge/wsClient';
import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';
import type { V2ClientMessage } from './secureProtocol';
import { isV1ForbiddenWorkspaceKind } from './secureProtocol';
import {
  LEGACY_CAPABILITIES,
  type BridgeCapability,
  type BridgeClient,
  type BridgeClientHandlers,
  type BridgeClientInfo,
  type BridgeClientKind,
  type LegacyWebBridgeClientOptions,
} from './types';
import { clearPairingStorage } from './pairing';

export class LegacyWebBridgeClient implements BridgeClient {
  readonly kind: BridgeClientKind = 'legacy_web';

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly WebSocketImpl?: typeof WebSocket;
  private permission: BridgeDevicePermission;
  private computerId: string | null;
  private status: BridgeConnectionState = 'idle';
  private client: BridgeWsClient | null = null;
  private handlers: BridgeClientHandlers = {};

  constructor(options: LegacyWebBridgeClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.WebSocketImpl = options.WebSocketImpl;
    this.permission = options.permission ?? 'read_only';
    this.computerId = options.computerId ?? null;
  }

  getInfo(): BridgeClientInfo {
    return {
      kind: this.kind,
      capabilities: LEGACY_CAPABILITIES,
      permission: this.permission,
      computerId: this.computerId,
      computerLabel: this.computerId,
      secureWorkspaceReady: false,
    };
  }

  hasCapability(capability: BridgeCapability): boolean {
    return (LEGACY_CAPABILITIES as readonly string[]).includes(capability);
  }

  getStatus(): BridgeConnectionState {
    return this.status;
  }

  connect(handlers: BridgeClientHandlers): void {
    this.handlers = handlers;
    this.client?.disconnect();
    const client = new BridgeWsClient({
      baseUrl: this.baseUrl,
      token: this.token,
      WebSocketImpl: this.WebSocketImpl,
    });
    this.client = client;
    this.setStatus('connecting');
    client.connect({
      onStateChange: (next: BridgeTransportState) => {
        if (this.client !== client) return;
        this.setStatus(next);
      },
      onMessage: (message: ServerMessage) => {
        if (this.client !== client) return;
        if (
          message.kind === 'error' &&
          (message.code === 'auth_revoked' || message.code === 'auth_expired')
        ) {
          this.setStatus('revoked');
          this.handlers.onMessage?.(message);
          this.disconnect();
          return;
        }
        if (message.kind === 'error' && message.code === 'backpressure') {
          this.handlers.onLagged?.();
        }
        this.handlers.onMessage?.(message);
      },
      onError: (error) => {
        if (this.client !== client) return;
        this.handlers.onError?.(error.message);
      },
    });
  }

  disconnect(): void {
    const current = this.client;
    this.client = null;
    current?.disconnect();
    if (this.status !== 'revoked') {
      this.setStatus('closed');
    }
  }

  send(command: ClientCommand): void {
    if (isV1ForbiddenWorkspaceKind(command.kind)) {
      throw new Error(
        `Legacy web bridge refuses workspace command "${command.kind}"; use secure v2 transport.`,
      );
    }
    this.client?.send(command);
  }

  sendV2(_command: V2ClientMessage): void {
    throw new Error(
      'Legacy web bridge has no secure workspace capability. Files, Diff, and drafts require the native secure client.',
    );
  }

  forgetPairing(): void {
    clearPairingStorage();
    this.disconnect();
    this.setStatus('idle');
  }

  private setStatus(status: BridgeConnectionState): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatusChange?.(status);
  }
}

export function createLegacyWebBridgeClient(
  options: LegacyWebBridgeClientOptions,
): LegacyWebBridgeClient {
  return new LegacyWebBridgeClient(options);
}
