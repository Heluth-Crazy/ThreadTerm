/**
 * Secure bridge protocol v2 DTOs — mirrors
 * `src-tauri/src/bridge/protocol/v2.rs` field names / kinds.
 *
 * Workspace content is request-scoped. Snapshots are metadata-only.
 * Files / Diff / drafts must never use plaintext v1.
 */

import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';
import type {
  DraftConflictState,
  DraftPatchResult,
  EditorLeaseSnapshot,
  TextChange,
  WorkspaceDraftMeta,
  WorkspaceRecord,
  WorkspaceTab,
  WorkspaceViewState,
} from '@shared/lib/workspace/types';

export const PROTOCOL_VERSION_V2 = 2 as const;
export const MAX_V2_PAYLOAD_BYTES = 1024 * 1024;

/** Canonical QR payload scanned from desktop secure pairing surface. */
export interface SecurePairQrPayload {
  protocol: number;
  host: string;
  port: number;
  otp: string;
  computerId: string;
  /** Lowercase hex SHA-256 of the desktop certificate DER. */
  fingerprint: string;
  /** wss://host:port endpoint */
  endpoint: string;
  expiresInSeconds?: number;
  maxPermission?: BridgeDevicePermission;
}

export interface WorkspaceMetaSnapshot {
  workspace: WorkspaceRecord;
  tabs: WorkspaceTab[];
  draftMetas: WorkspaceDraftMeta[];
  viewStates: WorkspaceViewState[];
  activeLeases: EditorLeaseSnapshot[];
  revision: number;
  permission: BridgeDevicePermission;
}

export type V2ClientMessage =
  | { kind: 'auth'; token: string }
  | {
      kind: 'pair';
      otp: string;
      device_name: string;
      permission?: BridgeDevicePermission;
      computer_id: string;
    }
  | { kind: 'ping'; t?: number }
  | { kind: 'subscribe_workspace'; workspace_id: string }
  | { kind: 'unsubscribe_workspace'; workspace_id: string }
  | { kind: 'get_workspace_snapshot'; request_id: string; workspace_id: string }
  | {
      kind: 'open_tab';
      request_id: string;
      workspace_id: string;
      tab_kind: string;
      title?: string;
      card_id?: string;
      relative_path?: string;
    }
  | {
      kind: 'close_tab';
      request_id: string;
      workspace_id: string;
      tab_id: string;
      force?: boolean;
    }
  | {
      kind: 'reorder_tabs';
      request_id: string;
      workspace_id: string;
      ordered_tab_ids: string[];
    }
  | {
      kind: 'set_active_tab';
      request_id: string;
      workspace_id: string;
      tab_id: string;
    }
  | {
      kind: 'read_file';
      request_id: string;
      workspace_id: string;
      relative_path: string;
    }
  | {
      kind: 'get_draft';
      request_id: string;
      workspace_id: string;
      tab_id: string;
    }
  | {
      kind: 'apply_draft_patch';
      request_id: string;
      workspace_id: string;
      tab_id: string;
      base_revision: number;
      changes: TextChange[];
      full_text?: string;
    }
  | {
      kind: 'save_draft';
      request_id: string;
      workspace_id: string;
      tab_id: string;
      expected_revision: number;
      force?: boolean;
    }
  | {
      kind: 'discard_draft';
      request_id: string;
      workspace_id: string;
      tab_id: string;
      expected_revision: number;
    }
  | {
      kind: 'acquire_lease';
      request_id: string;
      workspace_id: string;
      tab_id: string;
    }
  | {
      kind: 'renew_lease';
      request_id: string;
      workspace_id: string;
      tab_id: string;
    }
  | {
      kind: 'release_lease';
      request_id: string;
      workspace_id: string;
      tab_id: string;
    }
  | {
      kind: 'takeover_lease';
      request_id: string;
      workspace_id: string;
      tab_id: string;
    }
  | {
      kind: 'list_directory';
      request_id: string;
      workspace_id: string;
      relative_path?: string;
    }
  | { kind: 'terminal_resync' }
  | { kind: 'input'; card_id: string; data: string }
  | { kind: 'resize'; card_id: string; cols: number; rows: number };

export type V2ServerMessage =
  | {
      kind: 'pair_result';
      ok: boolean;
      device?: {
        id: string;
        name: string;
        permission: BridgeDevicePermission;
        createdAt: number;
        lastSeenAt?: number | null;
      };
      device_token?: string;
      computer_id?: string;
      expires_in_seconds?: number;
      error_code?: string;
      message?: string;
    }
  | {
      kind: 'auth_ok';
      device: {
        id: string;
        name: string;
        permission: BridgeDevicePermission;
        createdAt: number;
        lastSeenAt?: number | null;
      };
      computer_id: string;
      serverId: string;
      runtimeId: string;
    }
  | { kind: 'pong'; t: number }
  | {
      kind: 'workspace_snapshot';
      request_id?: string | null;
      snapshot: WorkspaceMetaSnapshot;
      runtimeId: string;
      workspaceSeq: number;
    }
  | {
      kind: 'workspace_result';
      request_id: string;
      ok: boolean;
      error_code?: string;
      message?: string;
      revision?: number;
      payload?: unknown;
    }
  | {
      kind: 'file_content';
      request_id: string;
      workspace_id: string;
      relative_path: string;
      contents: string;
      size_bytes: number;
      modified_unix_ms?: number | null;
    }
  | {
      kind: 'draft_content';
      request_id: string;
      workspace_id: string;
      tab_id: string;
      revision: number;
      dirty: boolean;
      conflict: DraftConflictState;
      contents: string;
      size_bytes: number;
    }
  | {
      kind: 'draft_patched';
      request_id: string;
      result: DraftPatchResult;
    }
  | {
      kind: 'error';
      code: string;
      message: string;
      request_id?: string | null;
    }
  | { kind: 'revoked'; reason: string }
  /** Terminal-compatible kinds reused over secure transport (same shapes as v1). */
  | {
      kind: 'terminal_output';
      card_id: string;
      data: string;
      seq: number;
      runtimeId?: string;
      streamSeq?: number;
    }
  | {
      kind: 'terminal_snapshot';
      cardId: string;
      data: string;
      seq: number;
      runtimeId?: string;
      streamSeq?: number;
      rows: number;
      cols: number;
      cursorRow: number;
      cursorCol: number;
      history?: string;
    };

export interface VersionedV2ServerMessage {
  protocol_version: typeof PROTOCOL_VERSION_V2 | number;
  kind: string;
  [key: string]: unknown;
}

/** Message kinds forbidden on plaintext v1 (must match Rust V1_FORBIDDEN_WORKSPACE_KINDS). */
export const V1_FORBIDDEN_WORKSPACE_KINDS = [
  'subscribe_workspace',
  'unsubscribe_workspace',
  'get_workspace_snapshot',
  'open_tab',
  'close_tab',
  'reorder_tabs',
  'set_active_tab',
  'read_file',
  'get_draft',
  'apply_draft_patch',
  'save_draft',
  'discard_draft',
  'acquire_lease',
  'renew_lease',
  'release_lease',
  'takeover_lease',
  'list_directory',
  'workspace_snapshot',
  'file_content',
  'draft_content',
] as const;

export function isV1ForbiddenWorkspaceKind(kind: string): boolean {
  return (V1_FORBIDDEN_WORKSPACE_KINDS as readonly string[]).includes(kind);
}

const FINGERPRINT_HEX = /^[0-9a-f]{64}$/;

export function normalizeFingerprint(value: string): string {
  return value.trim().toLowerCase().replace(/:/g, '');
}

export function isValidFingerprint(value: string): boolean {
  return FINGERPRINT_HEX.test(normalizeFingerprint(value));
}

export function parseSecurePairQrPayload(raw: unknown): SecurePairQrPayload {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('QR payload is not valid JSON.');
    }
  }
  if (!value || typeof value !== 'object') {
    throw new Error('QR payload must be an object.');
  }
  const obj = value as Record<string, unknown>;
  const protocol = Number(obj.protocol ?? obj.protocol_version);
  if (protocol !== PROTOCOL_VERSION_V2) {
    throw new Error(
      `Secure pairing requires protocol ${PROTOCOL_VERSION_V2}; received ${
        Number.isFinite(protocol) ? protocol : 'missing'
      }.`,
    );
  }
  const host = String(obj.host ?? '').trim();
  const port = Number(obj.port);
  const otp = String(obj.otp ?? '').trim();
  const computerId = String(obj.computerId ?? obj.computer_id ?? '').trim();
  const fingerprint = normalizeFingerprint(String(obj.fingerprint ?? ''));
  const endpoint = String(obj.endpoint ?? '').trim();
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error('QR payload is missing a valid host/port.');
  }
  if (!otp) throw new Error('QR payload is missing the pairing code.');
  if (!computerId) throw new Error('QR payload is missing computerId.');
  if (!isValidFingerprint(fingerprint)) {
    throw new Error('QR payload certificate fingerprint is invalid.');
  }
  if (!endpoint.startsWith('wss://')) {
    throw new Error('Secure pairing requires a wss:// endpoint.');
  }
  const maxPermission =
    obj.maxPermission === 'full' || obj.max_permission === 'full' ? 'full' : 'read_only';
  return {
    protocol: PROTOCOL_VERSION_V2,
    host,
    port,
    otp,
    computerId,
    fingerprint,
    endpoint,
    expiresInSeconds:
      typeof obj.expiresInSeconds === 'number'
        ? obj.expiresInSeconds
        : typeof obj.expires_in_seconds === 'number'
          ? obj.expires_in_seconds
          : undefined,
    maxPermission,
  };
}

export function withV2ProtocolVersion(
  message: V2ClientMessage,
): V2ClientMessage & { protocol_version: typeof PROTOCOL_VERSION_V2 } {
  return { protocol_version: PROTOCOL_VERSION_V2, ...message };
}

export function parseV2ServerMessage(raw: string): V2ServerMessage {
  if (raw.length > MAX_V2_PAYLOAD_BYTES) {
    throw new Error('Secure bridge payload exceeds 1 MiB.');
  }
  const parsed = JSON.parse(raw) as VersionedV2ServerMessage;
  if (!parsed || typeof parsed.kind !== 'string') {
    throw new Error('Secure bridge message has no kind.');
  }
  if (parsed.protocol_version !== PROTOCOL_VERSION_V2) {
    throw new Error(
      `Secure bridge protocol version mismatch: expected ${PROTOCOL_VERSION_V2}, received ${
        parsed.protocol_version ?? 'missing'
      }`,
    );
  }
  return parsed as unknown as V2ServerMessage;
}

/** Map a v1 terminal ClientCommand onto a v2 message when possible. */
export function mapV1CommandToV2(command: {
  kind: string;
  [key: string]: unknown;
}): V2ClientMessage | null {
  switch (command.kind) {
    case 'ping':
      return { kind: 'ping' };
    case 'terminal_resync':
      return { kind: 'terminal_resync' };
    case 'input':
      return {
        kind: 'input',
        card_id: String(command.card_id),
        data: String(command.data ?? ''),
      };
    case 'resize':
      return {
        kind: 'resize',
        card_id: String(command.card_id),
        cols: Number(command.cols),
        rows: Number(command.rows),
      };
    case 'auth':
      return { kind: 'auth', token: String(command.token) };
    default:
      return null;
  }
}
