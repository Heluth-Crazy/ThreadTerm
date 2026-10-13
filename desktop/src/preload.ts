import { contextBridge, ipcRenderer } from 'electron';
import { terminalPtyFromArguments } from './terminalEnvironment.js';
import {
  isRecord,
  isRuntimeEvent,
  type Method,
  type OutputChunk,
  type RequestParams,
  type RequestResult,
  type ThreadTermBridge,
  type PagePick,
} from '@threadterm/protocol';

const bridge: ThreadTermBridge = {
  platform: process.platform,
  exportChatMarkdown: payload => ipcRenderer.invoke('threadterm:export-chat-markdown', payload) as Promise<string | null>,
  windowsPty: terminalPtyFromArguments(process.platform, process.argv),
  request: async <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> =>
    ipcRenderer.invoke('threadterm:request', method, params) as Promise<RequestResult<M>>,
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { if (isRuntimeEvent(value)) listener(value); };
    ipcRenderer.on('threadterm:event', handler);
    return () => ipcRenderer.removeListener('threadterm:event', handler);
  },
  onDesktopNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!isRecord(value)) return;
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : undefined;
      const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId : undefined;
      const action = value.action === "command-palette" ? value.action : undefined;
      if (sessionId || workspaceId || action) listener({ sessionId, workspaceId, action });
    };
    ipcRenderer.on('threadterm:desktop-navigate', handler);
    return () => ipcRenderer.removeListener('threadterm:desktop-navigate', handler);
  },
  windowState: (): Promise<{ maximized: boolean }> => ipcRenderer.invoke('threadterm:window-state') as Promise<{ maximized: boolean }>,
  onWindowState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isRecord(value) && typeof value.maximized === 'boolean') listener({ maximized: value.maximized });
    };
    ipcRenderer.on('threadterm:window-state', handler);
    return () => ipcRenderer.removeListener('threadterm:window-state', handler);
  },
  subscribeOutput: async (sessionId, cursor, onChunk) => {
    const subscriptionId = crypto.randomUUID();
    const handler = async (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!isRecord(value) || value.id !== subscriptionId || !isOutputChunk(value.chunk)) return;
      try { await Promise.resolve(onChunk(value.chunk)); }
      finally { void ipcRenderer.invoke('threadterm:ack-output', subscriptionId); }
    };
    ipcRenderer.on('threadterm:output', handler);
    let result: unknown;
    try { result = await ipcRenderer.invoke('threadterm:subscribe-output', sessionId, cursor, subscriptionId) as unknown; }
    catch (error) { ipcRenderer.removeListener('threadterm:output', handler); throw error; }
    if (!isRecord(result) || typeof result.id !== 'string') { ipcRenderer.removeListener('threadterm:output', handler); throw new Error('Output subscription was rejected'); }
    return () => {
      ipcRenderer.removeListener('threadterm:output', handler);
      void ipcRenderer.invoke('threadterm:unsubscribe-output', subscriptionId);
    };
  },
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('threadterm:choose-directory') as Promise<string | null>,
  chooseSavePath: (kind): Promise<string | null> => ipcRenderer.invoke('threadterm:choose-save-path', kind) as Promise<string | null>,
  exportFile: (kind) => ipcRenderer.invoke('threadterm:export-file', kind) as Promise<{ path: string } | null>,
  activateDataRelocation: (prepared) => ipcRenderer.invoke('threadterm:activate-data-relocation', prepared) as Promise<{ activated: boolean }>,
  windowAction: (action) => ipcRenderer.invoke('threadterm:window-action', action) as Promise<void>,
  openWindow: (options) => ipcRenderer.invoke('threadterm:open-window', options) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke('threadterm:open-external', url) as Promise<void>,
  pickPageTarget: (request) => ipcRenderer.invoke('threadterm:pick-page-target', request),
  cancelPagePick: (frameName) => ipcRenderer.invoke('threadterm:cancel-page-pick', frameName),
  markPageTarget: (request) => ipcRenderer.invoke('threadterm:mark-page-target', request),
  readPageShot: (shotId) => ipcRenderer.invoke('threadterm:read-page-shot', shotId),
  deletePageShots: (shotIds) => ipcRenderer.invoke('threadterm:delete-page-shots', shotIds),
  onPageContextMenu: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!isRecord(value) || typeof value.frameName !== 'string' || !/^tt-preview-[a-z0-9-]{8,64}$/.test(value.frameName) || typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y) || (!isPagePick(value.pick) && value.staticFrame !== true)) return;
      listener({ frameName: value.frameName, x: value.x, y: value.y, ...(isPagePick(value.pick) ? { pick: value.pick } : { staticFrame: true }), selectionText: typeof value.selectionText === 'string' && value.selectionText.length <= 10000 ? value.selectionText : '' });
    };
    ipcRenderer.on('threadterm:page-context-menu', handler);
    return () => ipcRenderer.removeListener('threadterm:page-context-menu', handler);
  },
  openPluginsFolder: () => ipcRenderer.invoke('threadterm:open-plugins-folder') as Promise<void>,
  openDirectory: (projectId, worktreeId) => ipcRenderer.invoke('threadterm:open-directory', projectId, worktreeId) as Promise<void>,
  revealFile: (sessionId, path) => ipcRenderer.invoke('threadterm:reveal-file', sessionId, path) as Promise<void>,
  desktopPreferences: () => ipcRenderer.invoke('threadterm:desktop-preferences') as Promise<{ shortcuts: Record<string, string> }>,
  exportDiagnostics: () => ipcRenderer.invoke('threadterm:export-diagnostics') as Promise<string | null>,
  testNotification: () => ipcRenderer.invoke('threadterm:test-notification') as Promise<{ sent: boolean; reason?: string }>,
  scheduleElectronCacheCleanup: (schedule) => ipcRenderer.invoke('threadterm:schedule-electron-cache-cleanup', schedule) as Promise<{ scheduled: boolean; available: boolean; result?: string }>,
};

contextBridge.exposeInMainWorld('threadterm', bridge);
if (process.env.THREADTERM_V3_RELOCATION_QA === '1') {
  contextBridge.exposeInMainWorld('threadtermQa', {
    dropControl: (): Promise<void> => ipcRenderer.invoke('threadterm:qa-drop-control') as Promise<void>,
    resumeControl: (): Promise<void> => ipcRenderer.invoke('threadterm:qa-resume-control') as Promise<void>,
    failChatProjection: (sessionId: string): Promise<void> => ipcRenderer.invoke('threadterm:qa-fail-chat-projection', sessionId) as Promise<void>,
  });
}

function isOutputChunk(value: unknown): value is OutputChunk {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && Number.isSafeInteger(value.cursor)
    && Number(value.cursor) >= 0
    && value.data instanceof Uint8Array
    && (value.gap === undefined || typeof value.gap === 'boolean');
}

function isPagePick(value: unknown): value is PagePick {
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.title !== 'string' || !isRecord(value.viewport) || !isRecord(value.target)) return false;
  const viewport = value.viewport, target = value.target;
  return Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && (target.type === 'area' || target.type === 'element');
}
