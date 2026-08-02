import { describe, expect, it } from 'vitest';
import {
  DESKTOP_MAIN_SURFACE,
  HOME_TAB_ID,
  LEASE_DISCONNECT_GRACE_MS,
  MAX_DRAFT_BYTES,
  WORKSPACE_ERROR_CODES,
  WORKSPACE_EVENT_CHANNEL,
  parseWorkspaceErrorCode,
  type CloseTabDecisionKind,
  type DraftConflictState,
  type WorkspaceAvailability,
  type WorkspaceEvent,
  type WorkspaceTabKind,
} from './types';

/** Mirrors Rust `WorkspaceErrorCode::as_str` / `WORKSPACE_ERROR_CODES`. */
const RUST_ERROR_CODES = [
  'workspace_not_found',
  'workspace_unavailable',
  'tab_not_found',
  'path_outside_workspace',
  'path_invalid',
  'permission_denied',
  'lease_required',
  'lease_conflict',
  'stale_revision',
  'file_conflict',
  'file_too_large',
  'file_binary',
  'file_not_utf8',
  'file_not_found',
  'persistence_failed',
  'secure_transport_required',
  'invalid_argument',
] as const;

const TAB_KINDS: WorkspaceTabKind[] = ['home', 'terminal', 'file', 'diff'];
const AVAILABILITY: WorkspaceAvailability[] = ['available', 'unavailable'];
const CONFLICT: DraftConflictState[] = ['none', 'external_change', 'stale_revision'];
const CLOSE_KINDS: CloseTabDecisionKind[] = [
  'closeClean',
  'saveAndClose',
  'discardAndClose',
  'keepOpen',
];

describe('workspace authority contract', () => {
  it('locks error codes with Rust', () => {
    expect([...WORKSPACE_ERROR_CODES]).toEqual([...RUST_ERROR_CODES]);
  });

  it('parses wire error prefixes', () => {
    expect(parseWorkspaceErrorCode('stale_revision: Expected revision 1')).toBe(
      'stale_revision',
    );
    expect(parseWorkspaceErrorCode('totally unknown')).toBeNull();
  });

  it('locks constants and enum string values', () => {
    expect(HOME_TAB_ID).toBe('home');
    expect(DESKTOP_MAIN_SURFACE).toBe('desktop:main');
    expect(WORKSPACE_EVENT_CHANNEL).toBe('workspace://changed');
    expect(MAX_DRAFT_BYTES).toBe(1024 * 1024);
    expect(LEASE_DISCONNECT_GRACE_MS).toBe(30_000);
    expect(TAB_KINDS).toContain('file');
    expect(AVAILABILITY).toContain('unavailable');
    expect(CONFLICT).toContain('external_change');
    expect(CLOSE_KINDS).toContain('saveAndClose');
  });

  it('snapshot event variants never include body fields in the type shape', () => {
    const events: WorkspaceEvent[] = [
      {
        type: 'workspaceChanged',
        workspaceId: 'ws',
        availability: 'available',
      },
      {
        type: 'tabsChanged',
        workspaceId: 'ws',
        tabIds: ['file:a.ts'],
      },
      {
        type: 'draftRevision',
        workspaceId: 'ws',
        tabId: 'file:a.ts',
        revision: 2,
        dirty: true,
        conflict: 'none',
      },
      {
        type: 'leaseChanged',
        workspaceId: 'ws',
        tabId: 'file:a.ts',
        holderSurfaceId: DESKTOP_MAIN_SURFACE,
        revision: 2,
      },
      {
        type: 'conflict',
        workspaceId: 'ws',
        tabId: 'file:a.ts',
        conflict: 'external_change',
        revision: 2,
      },
    ];
    for (const event of events) {
      expect(JSON.stringify(event)).not.toMatch(/contents|fullText|body/i);
    }
  });
});
