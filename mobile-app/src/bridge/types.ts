/**
 * Unified BridgeClient contract for legacy web (v1 terminal-only) and
 * native secure workspace (v2) transports.
 *
 * Reducers and screens consume protocol DTOs through this interface so
 * platform choice stays outside business state.
 */

import type { ClientCommand, ServerMessage } from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';
import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';
import type {
  SecurePairQrPayload,
  V2ClientMessage,
  V2ServerMessage,
} from './secureProtocol';

export type BridgeClientKind = 'legacy_web' | 'native_secure';

/** Feature flags advertised by a transport after connect/auth. */
export type BridgeCapability =
  | 'terminal'
  | 'workspace_tabs'
  | 'files'
  | 'diff'
  | 'drafts'
  | 'leases';

export const LEGACY_CAPABILITIES: readonly BridgeCapability[] = ['terminal'] as const;

export const SECURE_WORKSPACE_CAPABILITIES: readonly BridgeCapability[] = [
  'terminal',
  'workspace_tabs',
  'files',
  'diff',
  'drafts',
  'leases',
] as const;

export type BridgeTerminalState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error'
  | 'reconnecting'
  | 'revoked'
  | 'fingerprint_mismatch'
  | 'protocol_incompatible'
  | 'expired';

export interface BridgeClientHandlers {
  onStatusChange?: (status: BridgeConnectionState | BridgeTerminalState) => void;
  onMessage?: (message: ServerMessage) => void;
  /** Secure v2 workspace / auth messages (never delivered on legacy web). */
  onV2Message?: (message: V2ServerMessage) => void;
  onLagged?: () => void;
  onError?: (message: string) => void;
}

export interface BridgeClientInfo {
  kind: BridgeClientKind;
  capabilities: readonly BridgeCapability[];
  permission: BridgeDevicePermission;
  computerId: string | null;
  /** Non-sensitive display label for the paired computer. */
  computerLabel: string | null;
  /** True only after authenticated secure pairing with workspace protocol. */
  secureWorkspaceReady: boolean;
}

export interface BridgeClient {
  readonly kind: BridgeClientKind;
  getInfo(): BridgeClientInfo;
  hasCapability(capability: BridgeCapability): boolean;
  getStatus(): BridgeConnectionState | BridgeTerminalState;
  connect(handlers: BridgeClientHandlers): void;
  disconnect(): void;
  /**
   * Send a v1 terminal/session command. Secure clients map compatible
   * kinds onto the v2 transport without rewriting terminal payload bytes.
   */
  send(command: ClientCommand): void;
  /**
   * Send a workspace/v2 command. Legacy clients throw — files/diff/drafts
   * must never travel over plaintext v1.
   */
  sendV2(command: V2ClientMessage): void;
  /**
   * Forget local pairing material. Secure native clears Keychain token;
   * legacy clears session storage only.
   */
  forgetPairing(): void | Promise<void>;
}

export interface LegacyWebBridgeClientOptions {
  baseUrl: string;
  token: string;
  permission?: BridgeDevicePermission;
  computerId?: string | null;
  WebSocketImpl?: typeof WebSocket;
}

export interface NativeSecureBridgeClientOptions {
  /** Scanned or manually entered QR payload (must include fingerprint). */
  qr?: SecurePairQrPayload | null;
  /** Already-paired computer metadata (non-secret). */
  computerId?: string | null;
  computerLabel?: string | null;
  fingerprint?: string | null;
  endpoint?: string | null;
  permission?: BridgeDevicePermission;
  /**
   * Test/mock transport. Production iOS injects the Tauri secure plugin.
   * Never available as a real Keychain/URLSession on Windows.
   */
  plugin?: NativeSecurePlugin;
}

/**
 * Native secure plugin surface (Tauri iOS plugin). Token never leaves native
 * storage after pair/store — JS only sees status and non-secret metadata.
 */
export interface NativeSecurePlugin {
  scanQr?(): Promise<SecurePairQrPayload>;
  validateQr(payload: unknown): SecurePairQrPayload;
  pair(request: {
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
  }>;
  connect(handlers: {
    onStatusChange: (status: BridgeTerminalState) => void;
    onMessage: (raw: string) => void;
    onError: (message: string) => void;
  }): Promise<void>;
  disconnect(): Promise<void>;
  send(raw: string): Promise<void>;
  forget(): Promise<void>;
  hasStoredToken(): Promise<boolean>;
  getStoredComputerMeta(): Promise<{
    computerId: string;
    computerLabel: string | null;
    fingerprint: string;
    endpoint: string;
    permission: BridgeDevicePermission;
  } | null>;
}

export function capabilitiesForKind(kind: BridgeClientKind): readonly BridgeCapability[] {
  return kind === 'native_secure' ? SECURE_WORKSPACE_CAPABILITIES : LEGACY_CAPABILITIES;
}

export function isWorkspaceMutationCapability(capability: BridgeCapability): boolean {
  return (
    capability === 'files' ||
    capability === 'diff' ||
    capability === 'drafts' ||
    capability === 'leases' ||
    capability === 'workspace_tabs'
  );
}
