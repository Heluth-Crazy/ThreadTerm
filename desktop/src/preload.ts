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
} from '@threadterm/protocol';

const bridge: ThreadTermBridge = {
  platform: process.platform,
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
  activateDataRelocation: (prepared) => ipcRenderer.invoke('threadterm:activate-data-relocation', prepared) as Promise<{ activated: boolean }>,
  windowAction: (action) => ipcRenderer.invoke('threadterm:window-action', action) as Promise<void>,
  openWindow: (options) => ipcRenderer.invoke('threadterm:open-window', options) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke('threadterm:open-external', url) as Promise<void>,
  openDirectory: (projectId, worktreeId) => ipcRenderer.invoke('threadterm:open-directory', projectId, worktreeId) as Promise<void>,
  desktopPreferences: () => ipcRenderer.invoke('threadterm:desktop-preferences') as Promise<{ shortcuts: Record<string, string> }>,
  exportDiagnostics: () => ipcRenderer.invoke('threadterm:export-diagnostics') as Promise<string | null>,
  testNotification: () => ipcRenderer.invoke('threadterm:test-notification') as Promise<{ sent: boolean; reason?: string }>,
  scheduleElectronCacheCleanup: (schedule) => ipcRenderer.invoke('threadterm:schedule-electron-cache-cleanup', schedule) as Promise<{ scheduled: boolean; available: boolean; result?: string }>,
};

contextBridge.exposeInMainWorld('threadterm', bridge);

function isOutputChunk(value: unknown): value is OutputChunk {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && Number.isSafeInteger(value.cursor)
    && Number(value.cursor) >= 0
    && value.data instanceof Uint8Array
    && (value.gap === undefined || typeof value.gap === 'boolean');
}
