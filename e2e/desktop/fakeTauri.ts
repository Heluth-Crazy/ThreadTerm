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
 *   - everything unknown → resolve(null) (all app callsites tolerate null)
 *
 * Control handle for tests: `window.__fakePty`
 *   - `emitOutput(id, data)` / `emitExit(id, code)`
 *   - `counts: { create, attachSnapshot, ack }` keyed by ptyId
 */
import type { Page } from '@playwright/test';

// ── Seed state (zustand persist payload) ─────────────────────────────────────

export interface SeedCard {
  id: string;
  ptyId: string;
  projectPath: string;
  projectName: string;
  terminalType: 'shell';
  status: 'idle';
  createdAt: number;
  lastActivity: number;
  lastOutput: string;
  lastReplyPreview: string;
  messageCount: number;
  events: unknown[];
  unread: boolean;
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
      terminalType: 'shell' as const,
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

interface FakeSeed {
  persistedState: Record<string, unknown>;
}

function buildSeed(cards: SeedCard[]): FakeSeed {
  return {
    persistedState: {
      cards,
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
    JSON.stringify({ state: seed.persistedState, version: 11 }),
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
  } = { create: {}, attachSnapshot: {}, ack: {} };

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
    emitOutput(id: string, data: string): void {
      const session = sessions.get(id);
      if (!session || !session.alive) return;
      session.seq += 1;
      session.history += data;
      emitEvent('pty-output', { id, data, seq: session.seq });
    },
    emitExit(id: string, code: number | null): void {
      const session = sessions.get(id);
      if (session) session.alive = false;
      emitEvent('pty-exit', { id, code });
    },
  };

  const args = (raw: unknown): Record<string, unknown> =>
    (raw ?? {}) as Record<string, unknown>;

  const invoke = async (cmd: string, rawArgs?: unknown): Promise<unknown> => {
    const a = args(rawArgs);
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

      // ── path / fs plugins (workflow discovery) ──────────────────────────
      case 'plugin:path|resolve_directory':
        return '/e2e-fake-home';
      case 'plugin:path|join':
        return ((a.paths as string[] | undefined) ?? []).filter(Boolean).join('/');
      case 'plugin:fs|read_dir':
        // Missing workflow directory → discovery treats it as empty.
        throw new Error('fake-fs: directory does not exist');

      // ── fake PTY ────────────────────────────────────────────────────────
      case 'pty_create': {
        const id = a.id as string;
        counts.create[id] = (counts.create[id] ?? 0) + 1;
        const existing = sessions.get(id);
        if (!existing) {
          sessions.set(id, { seq: 0, alive: true, history: '' });
        } else if (!existing.alive) {
          // Real backend spawns a fresh process for a dead session id.
          existing.seq = 0;
          existing.history = '';
          existing.alive = true;
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
        return null;
      }
      case 'pty_kill': {
        const session = sessions.get(a.id as string);
        if (session) session.alive = false;
        return null;
      }
      case 'pty_input':
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
      case 'provider_list_recent_sessions':
        return [];
      case 'native_platform_material_state':
        return { enabled: false, platform: 'macos' };
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
export async function installFakeTauri(page: Page, cards: SeedCard[]): Promise<void> {
  await page.addInitScript(installInPage, buildSeed(cards));
}
