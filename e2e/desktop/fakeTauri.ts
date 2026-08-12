/**
 * fakeTauri — desktop e2e harness (audit P2-6).
 *
 * Injects a fake `window.__TAURI_INTERNALS__` BEFORE any app module loads so
 * `isTauriEnv()` returns true and the module-scope `listen` binding in
 * `src/lib/tauri-bridge.ts` picks the real Tauri event path (routed here).
 *
 * The fake implements the minimal Tauri v2 internals protocol:
 *   - `transformCallback(cb)` → numeric callback id registry
 *   - `invoke('plugin:event|listen', { event, handler })` → per-event handler set
 *   - pty_* commands → in-page fake PTY sessions
 *   - managed_state_* commands → in-page managed storage with legacy import
 *   - everything unknown → resolve(null) (remaining app callsites tolerate null)
 *
 * Control handle for tests: `window.__fakePty`
 *   - `emitOutput(id, data)` / `emitExit(id, code)`
 *   - `counts: { create, attachSnapshot, ack }` keyed by ptyId
 *   - `ackedThrough` stores the highest cumulative ACK watermark per ptyId
 */
import type { Page } from '@playwright/test';

// ── Seed state (zustand persist payload) ─────────────────────────────────────

export interface SeedCard {
  id: string;
  ptyId: string;
  projectPath: string;
  projectName: string;
  terminalType: 'shell' | 'codex';
  status: 'idle';
  createdAt: number;
  lastActivity: number;
  lastOutput: string;
  lastReplyPreview: string;
  messageCount: number;
  events: unknown[];
  unread: boolean;
}

export interface SeedAgentSession {
  provider: 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi' | 'grok';
  id: string;
  /** Optional canonical resume id used to model child → root resolution. */
  resumeTargetId?: string;
  projectPath: string;
  nativeTitle?: string;
  titleKind: 'explicit' | 'generated' | 'unknown' | 'firstPrompt';
  firstUserMessagePreview?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  resumable: boolean;
}

export interface SeedAgentSessionCatalogBehavior {
  provider: SeedAgentSession['provider'];
  delayMs?: number;
  progress?: Array<{
    afterMs: number;
    phase: 'discovering' | 'connecting' | 'listing' | 'scanning' | 'enriching';
    completed: number;
    total?: number | null;
  }>;
  availability?: 'available' | 'missingCli' | 'unavailable' | 'error';
  warning?: string | null;
}

export function makeSeedCards(count: number): SeedCard[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const id = `e2e-card-${n}`;
    return {
      id,
      ptyId: id,
      projectPath: `/tmp/e2e-project-${n}`,
      projectName: `E2EProj${n}`,
      terminalType: 'shell',
      status: 'idle' as const,
      createdAt: now - 1000 * n,
      lastActivity: now - 1000 * n,
      lastOutput: '',
      lastReplyPreview: '',
      messageCount: 0,
      events: [],
      unread: false,
    };
  });
}

export function makeSeedCodexCard(): SeedCard {
  const now = Date.now();
  return {
    id: 'e2e-codex-card',
    ptyId: 'e2e-codex-card',
    projectPath: '/tmp/e2e-codex-project',
    projectName: 'E2ECodex',
    terminalType: 'codex',
    status: 'idle',
    createdAt: now - 1000,
    lastActivity: now - 1000,
    lastOutput: '',
    lastReplyPreview: '',
    messageCount: 0,
    events: [],
    unread: false,
  };
}

interface FakeSeed {
  persistedState: Record<string, unknown>;
  agentSessions: SeedAgentSession[];
  catalogBehaviors: SeedAgentSessionCatalogBehavior[];
}

function buildSeed(
  cards: SeedCard[],
  agentSessions: SeedAgentSession[],
  catalogBehaviors: SeedAgentSessionCatalogBehavior[],
): FakeSeed {
  return {
    persistedState: {
      cards,
      pendingTerminalConfigurations: {},
      blocks: {},
      bookmarks: [],
      focusedCardId: null,
      lastActiveCardId: null,
      selectedProjectPath: null,
      pinnedCardIds: [],
      notifications: [],
      notificationCentreOpen: false,
      aiExplainDefaultProvider: 'claude',
      bottomBarHidden: false,
      supervisorEnabled: false,
    },
    agentSessions,
    catalogBehaviors,
  };
}

// ── Page-injected fake (serialized by Playwright, runs pre-module-load) ──────

function installInPage(seed: FakeSeed): void {
  const win = window as unknown as Record<string, unknown>;
  if (win.__TAURI_INTERNALS__) return; // already installed for this document

  // Deterministic locale + persisted store snapshot (version must match the
  // store's current persist version so `migrate` is skipped).
  localStorage.setItem('userLanguage', 'en');
  localStorage.setItem('threadterm-shortcut-hint-dismissed', '1');
  localStorage.setItem(
    'threadterm-terminal-store',
    JSON.stringify({ state: seed.persistedState, version: 20 }),
  );

  type EventCallback = (event: { event: string; id: number; payload: unknown }) => void;
  const callbacks = new Map<number, EventCallback>();
  let nextCallbackId = 1;
  // event name → set of callback ids registered through plugin:event|listen
  const eventListeners = new Map<string, Set<number>>();

  interface FakeSession {
    seq: number;
    alive: boolean;
    history: string;
  }
  const sessions = new Map<string, FakeSession>();
  const counts: {
    create: Record<string, number>;
    attachSnapshot: Record<string, number>;
    ack: Record<string, number>;
    kill: Record<string, number>;
  } = { create: {}, attachSnapshot: {}, ack: {}, kill: {} };
  const ackedThrough: Record<string, number> = {};
  const inputs: Record<string, string[]> = {};
  const agentSessionState = {
    catalogCalls: [] as Array<{
      provider: string;
      query: string | null;
      requestId: number;
    }>,
    cancelledRequestIds: [] as number[],
    recentListCalls: 0,
    resumeResolveCalls: [] as Array<{ provider: string; sessionId: string }>,
    codexAppOpenCardCalls: 0,
  };
  const managedState = new Map<string, string | null>();

  // In-page workspace authority store (mirrors desktop service contract).
  type FakeWorkspaceTab = {
    id: string;
    workspaceId: string;
    kind: string;
    title: string;
    cardId: string | null;
    relativePath: string | null;
    sharedOrder: number;
    createdAtUnixMs: number;
    updatedAtUnixMs: number;
  };
  type FakeWorkspaceDraft = {
    workspaceId: string;
    tabId: string;
    revision: number;
    dirty: boolean;
    conflict: string;
    baseModifiedUnixMs: number | null;
    baseHash: string | null;
    sizeBytes: number;
    updatedAtUnixMs: number;
    contents: string;
  };
  type FakeWorkspace = {
    record: {
      id: string;
      canonicalRoot: string;
      displayPath: string;
      availability: string;
      createdAtUnixMs: number;
      updatedAtUnixMs: number;
    };
    tabs: Map<string, FakeWorkspaceTab>;
    drafts: Map<string, FakeWorkspaceDraft>;
    viewStates: Map<
      string,
      {
        workspaceId: string;
        surfaceId: string;
        activeTabId: string;
        lastSeenAtUnixMs: number;
      }
    >;
  };
  const workspaces = new Map<string, FakeWorkspace>();
  const workspaceByRoot = new Map<string, string>();
  let workspaceSeq = 1;

  const emitEvent = (event: string, payload: unknown): void => {
    const ids = eventListeners.get(event);
    if (!ids) return;
    for (const id of Array.from(ids)) {
      const cb = callbacks.get(id);
      if (cb) cb({ event, id, payload });
    }
  };

  win.__fakePty = {
    counts,
    ackedThrough,
    inputs,
    emitOutput(id: string, data: string): number {
      const session = sessions.get(id);
      if (!session || !session.alive) return 0;
      session.seq += 1;
      session.history += data;
      emitEvent('pty-output', { id, data, seq: session.seq });
      return session.seq;
    },
    emitExit(id: string, code: number | null): void {
      const session = sessions.get(id);
      if (session) session.alive = false;
      emitEvent('pty-exit', { id, code });
    },
  };
  win.__fakeAgentSessions = agentSessionState;
  win.__fakeManagedState = {
    getItem: (key: string): string | null => managedState.get(key) ?? null,
  };

  const args = (raw: unknown): Record<string, unknown> =>
    (raw ?? {}) as Record<string, unknown>;

  const invoke = async (cmd: string, rawArgs?: unknown): Promise<unknown> => {
    const a = args(rawArgs);
    if (cmd === 'codex_app_open_card') {
      agentSessionState.codexAppOpenCardCalls += 1;
    }
    switch (cmd) {
      // ── Tauri event plugin ──────────────────────────────────────────────
      case 'plugin:event|listen': {
        const event = a.event as string;
        const handler = a.handler as number;
        if (!eventListeners.has(event)) eventListeners.set(event, new Set());
        eventListeners.get(event)?.add(handler);
        return handler;
      }
      case 'plugin:event|unlisten': {
        const event = a.event as string;
        const eventId = a.eventId as number;
        eventListeners.get(event)?.delete(eventId);
        callbacks.delete(eventId);
        return null;
      }
      case 'plugin:event|emit':
      case 'plugin:event|emit_to':
        return null;
      case 'plugin:dialog|confirm':
        return true;
      case 'plugin:dialog|message':
        return 'Ok';

      // ── managed application state ───────────────────────────────────────
      case 'managed_state_get': {
        const key = String(a.key ?? '');
        return {
          initialized: managedState.has(key),
          value: managedState.get(key) ?? null,
          recoveredBackup: false,
        };
      }
      case 'managed_state_import_legacy': {
        const key = String(a.key ?? '');
        if (managedState.has(key)) return { imported: false };
        managedState.set(key, typeof a.value === 'string' ? a.value : null);
        return { imported: true };
      }
      case 'managed_state_set': {
        const key = String(a.key ?? '');
        managedState.set(key, typeof a.value === 'string' ? a.value : null);
        emitEvent('managed-state://changed', {
          key,
          sourceId: String(a.sourceId ?? ''),
        });
        return null;
      }
      case 'managed_state_remove': {
        const key = String(a.key ?? '');
        managedState.set(key, null);
        emitEvent('managed-state://changed', {
          key,
          sourceId: String(a.sourceId ?? ''),
        });
        return null;
      }

      // ── fake PTY ────────────────────────────────────────────────────────
      case 'pty_create': {
        const id = a.id as string;
        counts.create[id] = (counts.create[id] ?? 0) + 1;
        const existing = sessions.get(id);
        if (!existing) {
          sessions.set(id, { seq: 0, alive: true, history: '' });
          ackedThrough[id] = 0;
        } else if (!existing.alive) {
          // Real backend spawns a fresh process for a dead session id.
          existing.seq = 0;
          existing.history = '';
          existing.alive = true;
          ackedThrough[id] = 0;
        }
        return id;
      }
      case 'pty_get_session_state': {
        const session = sessions.get(a.ptyId as string);
        if (!session || !session.alive) {
          throw new Error(`fake-pty: unknown session ${String(a.ptyId)}`);
        }
        return 'Idle';
      }
      case 'pty_get_all_session_states': {
        const out: Record<string, string> = {};
        for (const [id, session] of sessions) {
          if (session.alive) out[id] = 'Idle';
        }
        return out;
      }
      case 'pty_attach_snapshot': {
        const ptyId = a.ptyId as string;
        counts.attachSnapshot[ptyId] = (counts.attachSnapshot[ptyId] ?? 0) + 1;
        const session = sessions.get(ptyId);
        if (!session || !session.alive) return null;
        return {
          ptyId,
          data: '',
          seq: session.seq,
          rows: 24,
          cols: 80,
          cursorRow: 0,
          cursorCol: 0,
          history: session.history,
        };
      }
      case 'pty_ack': {
        const id = a.id as string;
        counts.ack[id] = (counts.ack[id] ?? 0) + 1;
        const throughSeq = Number(a.throughSeq ?? 0);
        ackedThrough[id] = Math.max(ackedThrough[id] ?? 0, throughSeq);
        return null;
      }
      case 'pty_register_output_consumer':
      case 'pty_unregister_output_consumer':
        return null;
      case 'pty_kill': {
        const id = a.id as string;
        counts.kill[id] = (counts.kill[id] ?? 0) + 1;
        const session = sessions.get(id);
        if (session) session.alive = false;
        return null;
      }
      case 'pty_input': {
        const id = a.id as string;
        if (!inputs[id]) inputs[id] = [];
        inputs[id]?.push(String(a.data ?? ''));
        return null;
      }
      case 'pty_resize':
        return null;
      case 'pty_get_recent_output':
        return null;

      // ── misc app commands hit during startup ────────────────────────────
      case 'get_command_blocks_enabled':
      case 'set_command_blocks_enabled':
        return false;
      case 'bridge_status':
        return { running: false };
      case 'git_branch_overview':
      case 'git_worktree_list':
        return [];
      case 'provider_list_recent_sessions':
        agentSessionState.recentListCalls += 1;
        return [];
      case 'provider_resolve_resume_session': {
        const provider = String(a.provider);
        const sessionId = String(a.sessionId);
        agentSessionState.resumeResolveCalls.push({ provider, sessionId });
        const session = seed.agentSessions.find(
          (candidate) =>
            candidate.provider === provider
            && (
              candidate.id === sessionId
              || candidate.resumeTargetId === sessionId
            ),
        );
        if (
          !session
          || (session.provider !== 'claude' && session.provider !== 'codex')
        ) {
          return null;
        }
        return {
          id: session.resumeTargetId ?? session.id,
          provider: session.provider,
          projectPath: session.projectPath,
          updatedAt: session.updatedAt ?? null,
        };
      }
      case 'provider_list_agent_sessions': {
        const request = (a.request ?? {}) as Record<string, unknown>;
        const requestId = Number(request.requestId ?? 0);
        const provider = String(request.provider ?? 'claude');
        const query = typeof request.query === 'string' ? request.query.trim() : '';
        const needle = query.toLocaleLowerCase();
        agentSessionState.catalogCalls.push({
          provider,
          query: query || null,
          requestId,
        });
        const behavior = seed.catalogBehaviors.find(
          (candidate) => candidate.provider === provider,
        );
        for (const progress of behavior?.progress ?? []) {
          window.setTimeout(() => {
            emitEvent('agent-session://catalog-progress', {
              requestId,
              provider,
              phase: progress.phase,
              completed: progress.completed,
              total: progress.total ?? null,
              elapsedMs: progress.afterMs,
            });
          }, progress.afterMs);
        }
        if ((behavior?.delayMs ?? 0) > 0) {
          await new Promise((resolve) => {
            window.setTimeout(resolve, behavior?.delayMs ?? 0);
          });
        }
        const items = seed.agentSessions.filter((session) => {
          if (session.provider !== provider) return false;
          if (!needle) return true;
          return [
            session.id,
            session.projectPath,
            session.nativeTitle ?? '',
            session.firstUserMessagePreview ?? '',
          ].some((value) => value.toLocaleLowerCase().includes(needle));
        });
        return {
          provider,
          availability: behavior?.availability ?? 'available',
          items: behavior?.availability && behavior.availability !== 'available'
            ? []
            : items,
          nextCursor: null,
          scannedAt: Date.now(),
          warning: behavior?.warning ?? null,
        };
      }
      case 'provider_cancel_agent_session_scan':
        agentSessionState.cancelledRequestIds.push(Number(a.requestId ?? 0));
        return null;
      case 'provider_resolve_agent_session_metadata': {
        const request = (a.request ?? {}) as { keys?: Array<Record<string, unknown>> };
        const keys = Array.isArray(request.keys) ? request.keys : [];
        return keys.map((key) => {
          const provider = String(key.provider ?? '');
          const sessionId = String(key.sessionId ?? '');
          const session = seed.agentSessions.find(
            (candidate) =>
              candidate.provider === provider && candidate.id === sessionId,
          );
          if (!session) {
            return {
              key: { provider, sessionId, projectPath: key.projectPath ?? null },
              state: 'missing',
              summary: null,
              warning: null,
            };
          }
          return {
            key: { provider, sessionId, projectPath: key.projectPath ?? null },
            state: 'found',
            summary: {
              provider: session.provider,
              id: session.id,
              projectPath: session.projectPath,
              nativeTitle: session.nativeTitle ?? null,
              titleKind: session.titleKind,
              firstUserMessagePreview: session.firstUserMessagePreview ?? null,
              createdAt: session.createdAt ?? null,
              updatedAt: session.updatedAt ?? null,
              messageCount: session.messageCount ?? null,
              resumable: session.resumable,
            },
            warning: null,
          };
        });
      }
      case 'native_platform_material_state':
        return { enabled: false, platform: 'macos' };

      // ── Claude chat sidecar ─────────────────────────────────────────────
      // Chat stays gated off in e2e until the desktop-ui task ships real
      // fixtures; the remaining claude_chat_* commands are unreachable while
      // the probe reports unavailable.
      case 'claude_chat_probe':
        return {
          ok: false,
          missing: 'node',
          detail: 'fake-tauri: claude chat sidecar is not simulated',
          nodeVersion: null,
          claudeVersion: null,
        };

      // ── workspace authority (child 2) ───────────────────────────────────
      case 'workspace_ensure': {
        const rootPath = String(a.rootPath ?? '').replace(/[\\/]+$/, '');
        const existing = workspaceByRoot.get(rootPath);
        if (existing) return workspaces.get(existing)?.record ?? null;
        const id = `fake-ws-${workspaceSeq++}`;
        const now = Date.now();
        const record = {
          id,
          canonicalRoot: rootPath,
          displayPath: rootPath,
          availability: 'available',
          createdAtUnixMs: now,
          updatedAtUnixMs: now,
        };
        workspaces.set(id, {
          record,
          tabs: new Map(),
          drafts: new Map(),
          viewStates: new Map(),
        });
        workspaceByRoot.set(rootPath, id);
        return record;
      }
      case 'workspace_get': {
        return workspaces.get(String(a.workspaceId))?.record ?? null;
      }
      case 'workspace_list':
        return [...workspaces.values()].map((ws) => ws.record);
      case 'workspace_get_snapshot': {
        const ws = workspaces.get(String(a.workspaceId));
        if (!ws) throw new Error('workspace_not_found: missing');
        return {
          workspace: ws.record,
          tabs: [...ws.tabs.values()].sort(
            (left, right) => left.sharedOrder - right.sharedOrder,
          ),
          draftMetas: [...ws.drafts.values()].map(({ contents: _c, ...meta }) => meta),
          viewStates: [...ws.viewStates.values()],
          activeLeases: [],
        };
      }
      case 'workspace_open_tab': {
        const workspaceId = String(a.workspaceId);
        const ws = workspaces.get(workspaceId);
        if (!ws) throw new Error('workspace_not_found: missing');
        const request = (a.request ?? {}) as Record<string, unknown>;
        const kind = String(request.kind ?? 'file');
        if (kind === 'home') {
          return {
            id: 'home',
            workspaceId,
            kind: 'home',
            title: 'Home',
            cardId: null,
            relativePath: null,
            sharedOrder: 0,
            createdAtUnixMs: Date.now(),
            updatedAtUnixMs: Date.now(),
          };
        }
        let tabId = '';
        if (kind === 'terminal') tabId = `terminal:${String(request.cardId)}`;
        else if (kind === 'file') tabId = `file:${String(request.relativePath)}`;
        else tabId = `diff:${String(request.relativePath)}`;
        const existingTab = ws.tabs.get(tabId);
        if (existingTab) return existingTab;
        let maxOrder = 0;
        for (const tab of ws.tabs.values()) maxOrder = Math.max(maxOrder, tab.sharedOrder);
        const tab = {
          id: tabId,
          workspaceId,
          kind,
          title: String(request.title ?? tabId),
          cardId: request.cardId ? String(request.cardId) : null,
          relativePath: request.relativePath ? String(request.relativePath) : null,
          sharedOrder: maxOrder + 1,
          createdAtUnixMs: Date.now(),
          updatedAtUnixMs: Date.now(),
        };
        ws.tabs.set(tabId, tab);
        emitEvent('workspace://changed', {
          type: 'tabsChanged',
          workspaceId,
          tabIds: [tabId],
        });
        return tab;
      }
      case 'workspace_reorder_tabs': {
        const workspaceId = String(a.workspaceId);
        const ws = workspaces.get(workspaceId);
        if (!ws) throw new Error('workspace_not_found: missing');
        const ordered = (a.orderedTabIds as string[]) ?? [];
        let order = 1;
        for (const tabId of ordered) {
          if (tabId === 'home') continue;
          const tab = ws.tabs.get(tabId);
          if (tab) {
            tab.sharedOrder = order;
            order += 1;
          }
        }
        return [...ws.tabs.values()].sort((left, right) => left.sharedOrder - right.sharedOrder);
      }
      case 'workspace_set_active_tab': {
        const workspaceId = String(a.workspaceId);
        const ws = workspaces.get(workspaceId);
        if (!ws) throw new Error('workspace_not_found: missing');
        const surfaceId = String(a.surfaceId ?? 'desktop:main');
        const state = {
          workspaceId,
          surfaceId,
          activeTabId: String(a.activeTabId),
          lastSeenAtUnixMs: Date.now(),
        };
        ws.viewStates.set(surfaceId, state);
        return state;
      }
      case 'workspace_prepare_close': {
        const ws = workspaces.get(String(a.workspaceId));
        if (!ws) throw new Error('workspace_not_found: missing');
        const tabIds = (a.tabIds as string[]) ?? [];
        const cleanTabIds: string[] = [];
        const dirtyTabIds: string[] = [];
        const conflictTabIds: string[] = [];
        for (const tabId of tabIds) {
          if (tabId === 'home') continue;
          const draft = ws.drafts.get(tabId);
          if (draft?.conflict && draft.conflict !== 'none') conflictTabIds.push(tabId);
          else if (draft?.dirty) dirtyTabIds.push(tabId);
          else cleanTabIds.push(tabId);
        }
        return { cleanTabIds, dirtyTabIds, conflictTabIds };
      }
      case 'workspace_commit_close': {
        const workspaceId = String(a.workspaceId);
        const ws = workspaces.get(workspaceId);
        if (!ws) throw new Error('workspace_not_found: missing');
        const decisions = (a.decisions as Array<{ tabId: string; kind: string }>) ?? [];
        const closed: string[] = [];
        for (const decision of decisions) {
          if (decision.kind === 'keepOpen') continue;
          ws.tabs.delete(decision.tabId);
          ws.drafts.delete(decision.tabId);
          closed.push(decision.tabId);
        }
        return closed;
      }
      case 'workspace_get_draft': {
        const ws = workspaces.get(String(a.workspaceId));
        return ws?.drafts.get(String(a.tabId)) ?? null;
      }
      case 'workspace_ensure_draft': {
        const workspaceId = String(a.workspaceId);
        const tabId = String(a.tabId);
        const ws = workspaces.get(workspaceId);
        if (!ws) throw new Error('workspace_not_found: missing');
        const existing = ws.drafts.get(tabId);
        if (existing) return existing;
        const draft = {
          workspaceId,
          tabId,
          revision: 0,
          dirty: false,
          conflict: 'none',
          baseModifiedUnixMs: null,
          baseHash: null,
          sizeBytes: 0,
          updatedAtUnixMs: Date.now(),
          contents: '',
        };
        ws.drafts.set(tabId, draft);
        return draft;
      }
      case 'workspace_apply_draft_patch': {
        const patch = (a.patch ?? {}) as Record<string, unknown>;
        const workspaceId = String(patch.workspaceId);
        const tabId = String(patch.tabId);
        const ws = workspaces.get(workspaceId);
        if (!ws) throw new Error('workspace_not_found: missing');
        const prev = ws.drafts.get(tabId) ?? {
          workspaceId,
          tabId,
          revision: 0,
          dirty: false,
          conflict: 'none',
          baseModifiedUnixMs: null,
          baseHash: null,
          sizeBytes: 0,
          updatedAtUnixMs: Date.now(),
          contents: '',
        };
        const contents = typeof patch.fullText === 'string' ? patch.fullText : prev.contents;
        const next = {
          ...prev,
          contents,
          revision: prev.revision + 1,
          dirty: true,
          sizeBytes: contents.length,
          updatedAtUnixMs: Date.now(),
        };
        ws.drafts.set(tabId, next);
        return { revision: next.revision, dirty: true, sizeBytes: next.sizeBytes };
      }
      case 'workspace_diagnostics':
        return {
          registeredWorkspaces: workspaces.size,
          availableWorkspaces: workspaces.size,
          tabCount: [...workspaces.values()].reduce((sum, ws) => sum + ws.tabs.size, 0),
          dirtyDraftCount: 0,
          conflictDraftCount: 0,
          loadedDraftBytes: 0,
          activeLeases: 0,
          pendingPersistenceOps: 0,
          persistenceFailures: 0,
        };

      default:
        return null;
    }
  };

  win.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    plugins: { path: { sep: '/', delimiter: ':' } },
    callbacks,
    transformCallback: (cb: EventCallback): number => {
      const id = nextCallbackId;
      nextCallbackId += 1;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number): void => {
      callbacks.delete(id);
    },
    runCallback: (id: number, payload: unknown): void => {
      const cb = callbacks.get(id);
      if (cb) cb(payload as { event: string; id: number; payload: unknown });
    },
    convertFileSrc: (filePath: string): string => filePath,
    invoke,
  };

  // `@tauri-apps/api/event` _unlisten() touches this before invoking
  // plugin:event|unlisten — must exist or every unlisten() rejects.
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (): void => {},
  };
}

// ── Test-side helper ─────────────────────────────────────────────────────────

/**
 * Install the fake Tauri environment + seeded terminal cards. Must be called
 * before `page.goto()`.
 */
export async function installFakeTauri(
  page: Page,
  cards: SeedCard[],
  agentSessions: SeedAgentSession[] = [],
  catalogBehaviors: SeedAgentSessionCatalogBehavior[] = [],
): Promise<void> {
  await page.addInitScript(
    installInPage,
    buildSeed(cards, agentSessions, catalogBehaviors),
  );
}
