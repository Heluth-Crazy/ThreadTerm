import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { RuntimeClient } from './runtime-client.js';
import { HTML_PREVIEW_RTC_POLICY_CHANNEL, shouldDisableHtmlPreviewWebRtc, type HtmlPreviewGrantManager } from './htmlPreview.js';
import { resolveHtmlPreviewRoot } from './htmlPreviewRoot.js';

type GrantCommand = { type: 'grant'; projectId: string; worktreePath?: string; path: string; frameName: string; remote: boolean };
type GrantDocumentCommand = { type: 'grantDocument'; frameName: string; projectId: string; worktreePath?: string; path: string }
  | { type: 'grantDocument'; frameName: string; externalId: string };
type RevokeCommand = { type: 'revoke'; id: string };
type SelectCommand = { type: 'selectAll'; frameName: string };
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const frameName = (value: unknown): value is string => text(value, 80) && /^tt-preview-[a-z0-9-]{8,64}$/.test(value);

export type HtmlPreviewDocumentChunk = { path: string; size: number; offset: number; fingerprint?: string; chunk: string; eof: boolean };
/** The document source must go through the Local file backend router, so the setting and the
 * remote-machine binding both apply (`design.md` §4.2). Never `runtime.request` directly. */
export type HtmlPreviewDocumentRequest = (event: IpcMainInvokeEvent, method: 'filesystem.document.read' | 'filesystem.external.document.read', params: Record<string, unknown>) => Promise<HtmlPreviewDocumentChunk>;

export function parseHtmlPreviewCommand(value: unknown): GrantCommand | GrantDocumentCommand | RevokeCommand | SelectCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preview command');
  const data = value as Record<string, unknown>;
  if (data.type === 'selectAll' && Object.keys(data).length === 2 && typeof data.frameName === 'string' && /^tt-preview-[a-z0-9-]{8,64}$/.test(data.frameName)) return data as SelectCommand;
  if (data.type === 'revoke' && Object.keys(data).length === 2 && typeof data.id === 'string' && /^[a-f0-9]{32}$/.test(data.id)) return data as RevokeCommand;
  if (data.type === 'grantDocument') {
    if (data.externalId !== undefined) {
      if (!Object.keys(data).every(key => ['type', 'frameName', 'externalId'].includes(key))
        || !text(data.externalId, 256) || !frameName(data.frameName)) throw new Error('Invalid preview command');
      return data as GrantDocumentCommand;
    }
    if (!Object.keys(data).every(key => ['type', 'frameName', 'projectId', 'worktreePath', 'path'].includes(key))
      || !text(data.projectId, 256) || !text(data.path, 16384) || !frameName(data.frameName)
      || data.worktreePath !== undefined && !text(data.worktreePath, 4096)) throw new Error('Invalid preview command');
    return data as GrantDocumentCommand;
  }
  if (data.type !== 'grant' || !Object.keys(data).every(key => ['type', 'projectId', 'worktreePath', 'path', 'frameName', 'remote'].includes(key))
    || !text(data.projectId, 256) || !text(data.path, 16384) || typeof data.remote !== 'boolean'
    || !frameName(data.frameName)
    || data.worktreePath !== undefined && !text(data.worktreePath, 4096)) throw new Error('Invalid preview command');
  return data as GrantCommand;
}

export function registerHtmlPreviewIpc(manager: HtmlPreviewGrantManager, assertTrusted: (event: IpcMainInvokeEvent) => void, runtimeFor: (event: IpcMainInvokeEvent) => RuntimeClient, available = () => true, isRemote = (_event: IpcMainInvokeEvent) => false, documentRequest?: HtmlPreviewDocumentRequest): void {
  // This read-only policy query is the only channel the untrusted frame preload uses.
  ipcMain.on(HTML_PREVIEW_RTC_POLICY_CHANNEL, event => {
    try { event.returnValue = !event.senderFrame || shouldDisableHtmlPreviewWebRtc(event.senderFrame, event.sender.id, manager); }
    catch { event.returnValue = true; }
  });
  ipcMain.handle('threadterm:html-preview', createHtmlPreviewHandler(manager, assertTrusted, runtimeFor, available, isRemote, documentRequest));
}

export function createHtmlPreviewHandler(manager: HtmlPreviewGrantManager, assertTrusted: (event: IpcMainInvokeEvent) => void, runtimeFor: (event: IpcMainInvokeEvent) => RuntimeClient, available = () => true, isRemote = (_event: IpcMainInvokeEvent) => false, documentRequest?: HtmlPreviewDocumentRequest) {
  return async (event: IpcMainInvokeEvent, input: unknown) => {
    assertTrusted(event);
    const sender = event.sender, frame = event.senderFrame;
    if (!frame || sender.isDestroyed() || frame !== sender.mainFrame) throw new Error('Preview commands require the application main frame');
    const command = parseHtmlPreviewCommand(input);
    if (command.type === 'selectAll') {
      const grants = manager.listForOwner(sender.id);
      const target = sender.mainFrame.framesInSubtree.find(candidate => !candidate.detached && candidate.parent === sender.mainFrame
        && candidate.name === command.frameName && grants.some(grant => grant.frameTreeNodeId === candidate.frameTreeNodeId && candidate.url.startsWith(`tt-preview://${grant.id}/`)));
      if (!target) throw new Error('Preview frame is unavailable');
      await target.executeJavaScript('(()=>{const range=document.createRange();range.selectNodeContents(document.body);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)})()', false);
      return;
    }
    if (command.type === 'revoke') {
      if (manager.get(command.id)?.ownerWebContentsId === sender.id) manager.revoke(command.id);
      return;
    }
    if (!available()) throw new Error('The HTML preview safety preload is unavailable. Rebuild the desktop application.');
    const runtime = runtimeFor(event);
    const current = () => !sender.isDestroyed() && !frame.detached && sender.mainFrame === frame;
    if (command.type === 'grantDocument') {
      if (!documentRequest) throw new Error('Document previews are unavailable. Rebuild the desktop application.');
      if (!current()) throw new Error('Preview window closed');
      const source = { read: (offset: number, limit: number) => 'externalId' in command
        ? documentRequest(event, 'filesystem.external.document.read', { id: command.externalId, offset, limit })
        : documentRequest(event, 'filesystem.document.read', { projectId: command.projectId, ...(command.worktreePath ? { worktreePath: command.worktreePath } : {}), path: command.path, offset, limit }) };
      const grant = await manager.createDocument({ ownerWebContentsId: sender.id, frameName: command.frameName, source });
      if (!current()) { manager.revoke(grant.id); throw new Error('Preview window closed'); }
      return { id: grant.id, url: grant.url };
    }
    const hostSource = isRemote(event) ? { read: (path: string, offset: number, limit: number) => runtime.request('filesystem.preview.read', { projectId: command.projectId, ...(command.worktreePath ? { worktreePath: command.worktreePath } : {}), path, offset, limit }) } : undefined;
    const rootPath = hostSource ? '' : await resolveHtmlPreviewRoot({
      projects: async () => (await runtime.request('runtime.snapshot', {})).projects,
      worktrees: projectId => runtime.request('worktree.list', { projectId }),
    }, command);
    if (!current()) throw new Error('Preview window closed');
    const grant = await manager.create({ rootPath, entryPath: command.path, ownerWebContentsId: sender.id, frameName: command.frameName, remoteContentAllowed: command.remote, ...(hostSource ? { hostSource } : {}) });
    if (!current()) { manager.revoke(grant.id); throw new Error('Preview window closed'); }
    return { id: grant.id, url: grant.url };
  };
}
