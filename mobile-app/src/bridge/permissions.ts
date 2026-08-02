/**
 * Permission presentation helpers for the mobile workspace UI.
 * Backend remains authoritative — these only gate control surfaces.
 */

import type { BridgeDevicePermission } from '@shared/lib/tauri-bridge';
import type { BridgeCapability, BridgeClientInfo } from './types';

export type WorkspaceAction =
  | 'open_clean_tab'
  | 'reorder_tabs'
  | 'close_clean_tab'
  | 'set_active_tab'
  | 'terminal_input'
  | 'terminal_create'
  | 'terminal_end'
  | 'file_edit'
  | 'file_save'
  | 'file_discard'
  | 'lease_acquire'
  | 'lease_takeover'
  | 'lease_release'
  | 'open_file'
  | 'open_diff'
  | 'list_directory';

const READ_ONLY_ALLOWED: ReadonlySet<WorkspaceAction> = new Set([
  'open_clean_tab',
  'reorder_tabs',
  'close_clean_tab',
  'set_active_tab',
  'open_file',
  'open_diff',
  'list_directory',
]);

const FULL_ONLY: ReadonlySet<WorkspaceAction> = new Set([
  'terminal_input',
  'terminal_create',
  'terminal_end',
  'file_edit',
  'file_save',
  'file_discard',
  'lease_acquire',
  'lease_takeover',
  'lease_release',
]);

const CAPABILITY_FOR_ACTION: Partial<Record<WorkspaceAction, BridgeCapability>> = {
  open_file: 'files',
  open_diff: 'diff',
  file_edit: 'drafts',
  file_save: 'drafts',
  file_discard: 'drafts',
  lease_acquire: 'leases',
  lease_takeover: 'leases',
  lease_release: 'leases',
  list_directory: 'files',
  open_clean_tab: 'workspace_tabs',
  reorder_tabs: 'workspace_tabs',
  close_clean_tab: 'workspace_tabs',
  set_active_tab: 'workspace_tabs',
};

export interface ActionGateResult {
  allowed: boolean;
  reason: string | null;
}

export function canPerformAction(
  info: Pick<BridgeClientInfo, 'permission' | 'capabilities' | 'secureWorkspaceReady'>,
  action: WorkspaceAction,
  options: { connectionOpen?: boolean; dirty?: boolean } = {},
): ActionGateResult {
  const connectionOpen = options.connectionOpen ?? true;
  if (!connectionOpen) {
    return {
      allowed: false,
      reason: 'Desktop connection is unavailable. Mutations are disabled until reconnect.',
    };
  }

  const requiredCap = CAPABILITY_FOR_ACTION[action];
  if (requiredCap && !info.capabilities.includes(requiredCap)) {
    return {
      allowed: false,
      reason:
        'This action requires the secure workspace client (v2). Legacy mobile web is terminal-only.',
    };
  }

  if (options.dirty && action === 'close_clean_tab') {
    if (info.permission !== 'full') {
      return {
        allowed: false,
        reason: 'Read-only devices cannot close dirty file tabs. Save or discard requires full control.',
      };
    }
  }

  if (FULL_ONLY.has(action) && info.permission !== 'full') {
    return {
      allowed: false,
      reason: 'This device is read-only. Desktop enforces permission; re-pair with full control to edit.',
    };
  }

  if (info.permission === 'read_only' && !READ_ONLY_ALLOWED.has(action) && FULL_ONLY.has(action)) {
    return {
      allowed: false,
      reason: 'Read-only permission blocks this mutation.',
    };
  }

  return { allowed: true, reason: null };
}

export function isFullControl(permission: BridgeDevicePermission): boolean {
  return permission === 'full';
}

export function permissionExplanation(
  permission: BridgeDevicePermission,
  zh: boolean,
): string {
  if (permission === 'full') {
    return zh
      ? '完全控制：可输入终端、编辑文件并接管编辑权。桌面端仍做最终校验。'
      : 'Full control: terminal input, file edit, and lease takeover. Desktop remains authoritative.';
  }
  return zh
    ? '只读：可浏览共享标签、终端与文件，但不能写入或结束会话。'
    : 'Read-only: browse shared tabs, terminals, and files; no writes or session end.';
}
