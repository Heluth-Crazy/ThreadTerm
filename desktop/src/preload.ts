import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { terminalPtyFromArguments } from './terminalEnvironment.js';
import type { BrowserBridge, BrowserEvent } from '../../renderer/src/browserTypes.js';
import { isBrowserSharingState } from '../../renderer/src/browserTypes.js';
import type { BrowserHandoffBridge, BrowserHandoffEvent } from './browser/handoffTypes.js';
import type { BackgroundBridge } from './backgroundImagesCore.js';
import type { MachineBridge } from '../../renderer/src/machineTypes.js';
import type { RemoteFilesBridge } from '../../renderer/src/remoteFiles.js';
import {
  isRecord,
  isRuntimeEvent,
  type Method,
  type OutputChunk,
  type RequestParams,
  type RequestResult,
  type ThreadTermBridge,
  type PagePick,
  type AttachedFile,
} from '@threadterm/protocol';

type DesktopNavigateTarget = { sessionId?: string; workspaceId?: string; action?: 'command-palette' | 'computers' };
const desktopNavigateListeners = new Set<(target: DesktopNavigateTarget) => void>();
let pendingDesktopNavigate: DesktopNavigateTarget | undefined;
ipcRenderer.on('threadterm:desktop-navigate', (_event, value: unknown) => {
  if (!isRecord(value)) return;
  const target: DesktopNavigateTarget = {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : undefined,
    action: value.action === 'command-palette' || value.action === 'computers' ? value.action : undefined,
  };
  if (!target.sessionId && !target.workspaceId && !target.action) return;
  if (desktopNavigateListeners.size) for (const listener of desktopNavigateListeners) listener(target);
  else pendingDesktopNavigate = target;
});
type FilePathBridge = { getPathForFile: (file: File) => string };
const bridge: ThreadTermBridge & BrowserBridge & BrowserHandoffBridge & BackgroundBridge & FilePathBridge & MachineBridge & RemoteFilesBridge = {
  localFiles: {
    getBackend: () => ipcRenderer.invoke('threadterm:local-files-get-backend'),
    setBackend: backend => ipcRenderer.invoke('threadterm:local-files-set-backend', backend),
    onBackendChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { if (value === 'runtime' || value === 'main') listener(value); };
      ipcRenderer.on('threadterm:local-files-backend-changed', handler);
      return () => ipcRenderer.removeListener('threadterm:local-files-backend-changed', handler);
    },
  },
  uploadClientFiles: (sessionId, paths) => ipcRenderer.invoke('threadterm:upload-client-files', sessionId, paths),
  readAttachPaths: paths => ipcRenderer.invoke('threadterm:read-attach-paths', paths),
  persistPageShot: (id, sessionId, projectId, root) => ipcRenderer.invoke('threadterm:persist-page-shot', id, sessionId, projectId, root),
  onHostFiles: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { if (isRecord(value) && typeof value.id === 'string' && ['directory', 'files', 'reveal'].includes(String(value.mode)) && (value.path === undefined || typeof value.path === 'string') && (value.selectedPath === undefined || typeof value.selectedPath === 'string')) listener(value as import('../../renderer/src/remoteFiles.js').HostFilesRequest); };
    ipcRenderer.on('threadterm:host-files', handler);
    return () => ipcRenderer.removeListener('threadterm:host-files', handler);
  },
  completeHostFiles: (id, paths) => ipcRenderer.invoke('threadterm:host-files-complete', id, paths),
  machineId: process.argv.find(value => value.startsWith('--threadterm-machine-id='))?.slice('--threadterm-machine-id='.length) ?? 'local',
  machineList: () => ipcRenderer.invoke('threadterm:machine-list'),
  machineShow: (id, sessionId) => ipcRenderer.invoke('threadterm:machine-show', id, sessionId),
  machineSettings: () => ipcRenderer.invoke('threadterm:machine-settings'),
  machineTree: () => ipcRenderer.invoke('threadterm:machine-tree-get'),
  machineExpand: (key, expanded) => ipcRenderer.invoke('threadterm:machine-expand', key, expanded),
  onMachineTree: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../../renderer/src/machineTypes.js').MachineTreeFeed) => { if (value && Array.isArray(value.machines) && isRecord(value.expanded)) listener(value); };
    ipcRenderer.on('threadterm:machine-tree', handler);
    return () => ipcRenderer.removeListener('threadterm:machine-tree', handler);
  },
  machinePrepare: text => ipcRenderer.invoke('threadterm:machine-prepare', text),
  machineAdd: options => ipcRenderer.invoke('threadterm:machine-add', options),
  machineRemove: id => ipcRenderer.invoke('threadterm:machine-remove', id),
  onMachinesChanged: listener => {
    const handler = () => listener();
    ipcRenderer.on('threadterm:machines-changed', handler);
    return () => ipcRenderer.removeListener('threadterm:machines-changed', handler);
  },
  browserCommand: command => ipcRenderer.invoke('threadterm:browser-command', command),
  onBrowserEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { if (isBrowserEvent(value)) listener(value); };
    ipcRenderer.on('threadterm:browser-event', handler);
    return () => ipcRenderer.removeListener('threadterm:browser-event', handler);
  },
  browserHandoff: command => ipcRenderer.invoke('threadterm:browser-handoff', command),
  onBrowserHandoffEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { if (isBrowserHandoffEvent(value)) listener(value); };
    ipcRenderer.on('threadterm:browser-handoff-event', handler);
    return () => ipcRenderer.removeListener('threadterm:browser-handoff-event', handler);
  },
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
  onDesktopNavigate: listener => {
    desktopNavigateListeners.add(listener);
    if (pendingDesktopNavigate) {
      const target = pendingDesktopNavigate; pendingDesktopNavigate = undefined;
      queueMicrotask(() => { if (desktopNavigateListeners.has(listener)) listener(target); });
    }
    return () => { desktopNavigateListeners.delete(listener); };
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
  attachFiles: () => ipcRenderer.invoke('threadterm:attach-files') as Promise<AttachedFile[]>,
  openExternalFiles: () => ipcRenderer.invoke('threadterm:open-external-files') as Promise<string[]>,
  getPathForFile: file => webUtils.getPathForFile(file),
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
  pickBackgroundImage: () => ipcRenderer.invoke('threadterm:background-pick') as Promise<{ name: string; mime: string; bytes: Uint8Array } | null>,
  readBackgroundSource: (path) => ipcRenderer.invoke('threadterm:background-read-source', path) as Promise<{ name: string; mime: string; bytes: Uint8Array }>,
  storeBackgroundImage: (input) => ipcRenderer.invoke('threadterm:background-store', input),
  storeBackgroundVariant: (input) => ipcRenderer.invoke('threadterm:background-store-variant', input),
  listBackgroundImages: () => ipcRenderer.invoke('threadterm:background-list'),
  removeBackgroundImage: (id) => ipcRenderer.invoke('threadterm:background-remove', id) as Promise<void>,
  pruneBackgroundImages: (keepIds) => ipcRenderer.invoke('threadterm:background-prune', keepIds) as Promise<void>,
};

Object.assign(bridge, {
  // Theme packs carry their background images; the desktop validates and stores them (desktop/src/themePackCore.ts).
  importThemePackImages: (images: unknown) => ipcRenderer.invoke('threadterm:theme-pack-import-images', images),
  htmlPreview: (command: unknown) => ipcRenderer.invoke('threadterm:html-preview', command),
  onHtmlPreviewLink: (listener: (value: { frameName: string; url: string; grantId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!isRecord(value) || typeof value.frameName !== 'string' || !/^tt-preview-[a-z0-9-]{8,64}$/.test(value.frameName)
        || typeof value.url !== 'string' || value.url.length > 16384 || typeof value.grantId !== 'string' || !/^[a-f0-9]{32}$/.test(value.grantId)) return;
      try { const url = new URL(value.url); if (url.protocol === 'http:' || url.protocol === 'https:') listener({ frameName: value.frameName, url: url.href, grantId: value.grantId }); } catch { /* Reject malformed page links. */ }
    };
    ipcRenderer.on('threadterm:html-preview-link', handler);
    return () => ipcRenderer.removeListener('threadterm:html-preview-link', handler);
  },
});

if (process.isMainFrame) contextBridge.exposeInMainWorld('threadterm', bridge);
if (process.isMainFrame && process.env.THREADTERM_V3_RELOCATION_QA === '1') {
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

function isBrowserEvent(value: unknown): value is BrowserEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'open') { if(typeof value.url!=='string'||value.url.length>16384)return false;try{return /^https?:$/.test(new URL(value.url).protocol);}catch{return false;} }
  if (value.type === 'popup') return typeof value.openerId === 'string' && typeof value.tabId === 'string' && typeof value.url === 'string' && value.url.length <= 16384;
  if (value.type === 'shortcut') return (value.phase===undefined||value.phase==='keydown'||value.phase==='keyup') && typeof value.tabId === 'string' && typeof value.key === 'string' && typeof value.code === 'string' && ['control', 'meta', 'shift', 'alt'].every(key => typeof value[key] === 'boolean');
  if (value.type !== 'state' || !isRecord(value.state)) return false;
  const state = value.state;
  return typeof state.tabId === 'string' && typeof state.url === 'string' && typeof state.title === 'string'
    && typeof state.loading === 'boolean' && typeof state.canGoBack === 'boolean' && typeof state.canGoForward === 'boolean'
    && typeof state.zoom === 'number' && Number.isFinite(state.zoom) && Number.isSafeInteger(state.documentGeneration)
    && ['pending', 'load_observed', 'failed'].includes(String(state.navigation))
    && (state.sharing === undefined || isBrowserSharingState(state.sharing))
    && (state.snapshot === undefined || typeof state.snapshot === 'string' && state.snapshot.startsWith('data:image/png;base64,'));
}
function isBrowserHandoffEvent(value: unknown): value is BrowserHandoffEvent {
  if (!isRecord(value)) return false;
  if(value.type==='preferences')return typeof value.devServerOffers==='boolean';
  const errors=value.errors,warnings=value.warnings;
  return value.type==='console' && typeof value.tabId==='string' && Number.isSafeInteger(value.documentGeneration)
    && typeof errors==='number' && Number.isSafeInteger(errors) && errors>=0 && typeof warnings==='number' && Number.isSafeInteger(warnings) && warnings>=0;
}
