// Mounted-production-ChatView fixture for the composer inline-mention DOM QA.
// It runs inside an isolated Electron renderer (real React 19 + real DOM) with a
// controllable bridge mock, so deferred `chat.read`, submission failures and
// revision conflicts can be driven deterministically. No runtime, provider or
// user data is touched.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from '../../renderer/src/components/ChatView';
import { I18nProvider } from '../../renderer/src/i18n';
import '../../renderer/src/styles.css';

type QaListeners = Array<(event: unknown) => void>;
type QaState = {
  sessionId: string;
  status: string;
  locale: 'en' | 'zh-CN';
  draft: string;
  revision: number;
  items: unknown[];
  files: string[];
  sessions: unknown[];
  capabilities: Record<string, unknown>;
  queue: { sessionId: string; paused: boolean; items: unknown[] };
  readGate: boolean;
  readItems: unknown[];
  sendGate: boolean;
  sendResolvers: Array<() => void>;
  sendError?: string;
  saveError?: string;
  clearError: boolean;
  savedDrafts: string[];
  sent: string[];
  queued: string[];
  steered: string[];
  notes: string[];
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  resolvers: Array<() => void>;
  listeners: QaListeners;
};

const qa: QaState = {
  sessionId: 'composer-dom',
  status: 'idle',
  locale: 'en',
  draft: '',
  revision: 0,
  items: [],
  files: ['src/alpha.ts', 'src/beta.ts'],
  sessions: [{
    id: 'other-1', projectId: 'p1', title: 'Other chat', provider: 'claude', mode: 'chat',
    status: 'idle', createdAt: 'now', updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  capabilities: { images: true, steer: false },
  queue: { sessionId: 'composer-dom', paused: false, items: [] },
  readGate: false,
  readItems: [{ id: 'm1', role: 'user', turnId: 't', createdAt: 'now', parts: [{ type: 'text', text: 'hello from the other chat' }] }],
  sendGate: false,
  sendResolvers: [],
  clearError: false,
  savedDrafts: [],
  sent: [],
  queued: [],
  steered: [],
  notes: [],
  calls: [],
  resolvers: [],
  listeners: [],
};

function route(method: string, params: Record<string, unknown>): Promise<unknown> | unknown {
  qa.calls.push({ method, params });
  switch (method) {
    case 'chat.draft.read': return { text: qa.draft, revision: qa.revision };
    case 'chat.draft.save':
      if (qa.saveError) throw new Error(qa.saveError);
      if (qa.clearError && params.text === '') throw new Error('');
      qa.revision = Number(params.expectedRevision ?? 0) + 1;
      qa.savedDrafts.push(String(params.text));
      return { text: params.text, revision: qa.revision };
    case 'chat.snapshot': return { items: qa.items, revision: 1 };
    case 'chat.options': return { options: [], commands: [], loadState: 'unknown', inputCapabilities: qa.capabilities };
    case 'chat.connection': return { sessionId: params.sessionId, runtimeEpoch: 'e', connectionGeneration: 1, revision: 1, phase: 'ready', optionsLoadState: 'unknown' };
    case 'chat.connect': return { sessionId: params.sessionId, runtimeEpoch: 'e', connectionGeneration: 2, revision: 2, phase: 'ready', optionsLoadState: 'unknown' };
    case 'session.claim': return { leaseEpoch: 1 };
    case 'session.renew': return { leaseEpoch: 1 };
    case 'session.release': return null;
    case 'chat.queue.read': return qa.queue;
    case 'chat.feedback.read': return { notes: [] };
    case 'chat.context.read': return null;
    case 'chat.backgroundTasks.list': return { tasks: [] };
    case 'filesystem.files': return { paths: qa.files };
    case 'git.log': return { commits: [] };
    case 'chat.read':
      if (qa.readGate) return new Promise(resolve => { qa.resolvers.push(() => resolve(qa.readItems)); });
      return qa.readItems;
    case 'chat.send': {
      if (qa.sendError) throw new Error(qa.sendError);
      const text = String(params.text);
      const complete = () => { qa.sent.push(text); return { turnId: `turn-${qa.sent.length}` }; };
      if (qa.sendGate) return new Promise(resolve => { qa.sendResolvers.push(() => resolve(complete())); });
      return complete();
    }
    case 'chat.queue.add':
      qa.queued.push(String(params.text));
      qa.queue = { sessionId: qa.sessionId, paused: false, items: [{ id: `q-${qa.queued.length}`, text: params.text, images: params.images ?? [] }] };
      return qa.queue;
    case 'chat.queue.remove': qa.queue = { sessionId: qa.sessionId, paused: false, items: [] }; return qa.queue;
    case 'chat.steer': qa.steered.push(String(params.text)); return null;
    case 'chat.feedback.add': qa.notes.push(String(params.text)); return null;
    default: throw new Error(`Unexpected QA request ${method}`);
  }
}

const bridge = {
  platform: 'win32',
  request: async (method: string, params: Record<string, unknown>) => route(method, params),
  onEvent: (listener: (event: unknown) => void) => { qa.listeners.push(listener); return () => { const index = qa.listeners.indexOf(listener); if (index >= 0) qa.listeners.splice(index, 1); }; },
  onDesktopNavigate: () => () => {},
  windowState: async () => ({ maximized: false }),
  onWindowState: () => () => {},
  chooseDirectory: async () => null,
  attachFiles: async () => [],
  chooseSavePath: async () => null,
  exportFile: async () => null,
  activateDataRelocation: async () => ({ activated: false }),
  desktopPreferences: async () => ({ shortcuts: {} }),
  exportDiagnostics: async () => null,
  testNotification: async () => ({ sent: false }),
  scheduleElectronCacheCleanup: async () => ({ scheduled: false, available: false }),
  openExternal: async () => undefined,
  openPluginsFolder: async () => undefined,
  openDirectory: async () => undefined,
  revealFile: async () => undefined,
  openWindow: async () => undefined,
  windowAction: async () => undefined,
  subscribeOutput: async () => () => {},
  pickPageTarget: async () => undefined,
  cancelPagePick: async () => undefined,
  markPageTarget: async () => undefined,
  readPageShot: async () => undefined,
  deletePageShots: async () => undefined,
  onPageContextMenu: () => () => {},
};
(window as unknown as { threadterm: unknown }).threadterm = bridge;

let root: ReturnType<typeof createRoot> | undefined;

function render() {
  const target = document.getElementById('root')!;
  root ??= createRoot(target);
  const session = {
    id: qa.sessionId,
    projectId: 'p1',
    worktreePath: 'C:/repo',
    provider: 'claude',
    mode: 'chat',
    status: qa.status,
    title: 'Composer DOM QA',
    createdAt: 'now',
    updatedAt: 'now',
  };
  root.render(
    React.createElement(I18nProvider, { locale: qa.locale },
      React.createElement(ChatView, {
        key: qa.sessionId,
        session,
        sessions: qa.sessions as never,
        delegationEnabled: false,
        sessionInfoEnabled: false,
      })),
  );
}

const api = {
  state: qa,
  render: (patch?: Partial<QaState>) => { if (patch) Object.assign(qa, patch); render(); },
  update: (patch: Partial<QaState>) => { Object.assign(qa, patch); render(); },
  releaseRead: () => { qa.readGate = false; const resolvers = qa.resolvers.splice(0); for (const resolve of resolvers) resolve(); },
  releaseSend: () => { qa.sendGate = false; const resolvers = qa.sendResolvers.splice(0); for (const resolve of resolvers) resolve(); },
  emit: (event: unknown) => { for (const listener of [...qa.listeners]) listener(event); },
  calls: qa.calls,
  reset: (patch?: Partial<QaState>) => {
    Object.assign(qa, {
      sessionId: 'composer-dom', status: 'idle', locale: 'en', draft: '', revision: 0, items: [], queue: { sessionId: 'composer-dom', paused: false, items: [] },
      readGate: false, clearError: false, savedDrafts: [], sent: [], queued: [], steered: [], notes: [], calls: [], resolvers: [],
      sendGate: false, sendResolvers: [], sendError: undefined, saveError: undefined,
    }, patch ?? {});
    if (!patch || !('queue' in patch)) qa.queue = { sessionId: qa.sessionId, paused: false, items: [] };
    render();
  },
};
(window as unknown as { qa: unknown }).qa = api;

render();
