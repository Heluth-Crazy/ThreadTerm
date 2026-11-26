import type { BrowserBridge, BrowserCommand, BrowserEvent, BrowserPreferences, BrowserState } from './browserTypes';
import type { BrowserHandoffBridge, BrowserHandoffCommand, BrowserHandoffEvent, BrowserHandoffResult, BrowserHandoffResultFor } from '../../desktop/src/browser/handoffTypes';
import type { BackgroundBridge } from '../../desktop/src/backgroundImagesCore';
import type { PagePick, PageRect, PageTargetRef, ChatItem, Method, NativeHistoryItem, OutputChunk, ProviderId, RequestParams, RequestResult, RuntimeEvent, Snapshot } from "@threadterm/protocol";
export type { ChatItem, NativeHistoryItem, ProviderId, Snapshot } from "@threadterm/protocol";
import { isRepeatableRead, normalizeRequestError, transportKind } from "./requestErrors";
import { reportTransportFailure, reportTransportRecovered } from "./notices";

function facade() { return window.threadterm; }

/**
 * How long a read keeps trying before its view hears of a failure: a runtime that answers too slowly gets 3 min; a
 * dropped connection about 15 s (the desktop reconnects meanwhile, and the header chip already says so). A runtime
 * that cannot start at all must still reach the app's "unavailable" screen quickly.
 */
const READ_PATIENCE_MS = { timeout: 180_000, unavailable: 15_000 } as const;
/** Pauses between reads sent again while the connection is down. */
const RECONNECT_BACKOFF_MS = [800, 2_000, 4_000, 8_000];
/** The app's own connection handling reads these: they report failures at once (App.tsx refresh, status checks). */
const OWN_RETRY = new Set<string>(['runtime.snapshot', 'runtime.health']);
const readerZh = () => (globalThis.document?.documentElement?.lang ?? '').toLowerCase().startsWith('zh');

/**
 * Every runtime request (owner 11-25: timeouts showed as red bars inside views and stayed). Failures arrive without
 * Electron's IPC wrapper, transport failures in the reader's language (requestErrors.ts). A read never fails only
 * because the runtime is slow or reconnecting: it is sent again (a timed-out one at once, it already waited; a
 * dropped connection after a pause) for up to READ_PATIENCE_MS, while one app-wide notice says the runtime is slow;
 * the first answer clears the notice and the view simply gets its data (notices.ts). Actions are never repeated:
 * they fail at once with a message that says the action may still be running.
 */
async function send<M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> {
  const read = isRepeatableRead(method) && !OWN_RETRY.has(method);
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await facade().request(method, params);
      reportTransportRecovered();
      return result;
    } catch (caught) {
      const error = normalizeRequestError(caught, method);
      const kind = transportKind(error);
      if (!kind || !read) throw error;
      reportTransportFailure(kind, readerZh());
      if (Date.now() - started >= READ_PATIENCE_MS[kind]) throw error;
      if (kind === 'unavailable') await new Promise(resolve => setTimeout(resolve, RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]));
    }
  }
}
export const snapshot = () => send("runtime.snapshot", {});
export const request = <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> => send(method, params);
export const subscribeEvents = (listener: (event: RuntimeEvent) => void) => facade().onEvent(listener);
export const onDesktopNavigate = (listener: (target: { sessionId?: string; workspaceId?: string; action?:"command-palette"|"computers"|"new-session"|"add-project"; projectId?: string; path?: string }) => void) => facade().onDesktopNavigate(listener);
export const windowState = () => facade().windowState?.() ?? Promise.resolve({ maximized: false });
export const onWindowState = (listener: (state: { maximized: boolean }) => void) => facade().onWindowState?.(listener) ?? (() => {});
export const chooseDirectory = () => facade().chooseDirectory();
export const attachFiles = () => facade().attachFiles();
export const openExternalFiles = () => facade().openExternalFiles();
export const chooseSavePath = (kind: 'database' | 'settings' | 'theme') => facade().chooseSavePath(kind);
export const exportFile = (kind: 'settings' | 'theme') => facade().exportFile(kind) as Promise<{ path: string; missingImages?: string[] } | null>;
export const activateDataRelocation = (prepared: Awaited<ReturnType<typeof request<'data.relocation.prepare'>>>) => facade().activateDataRelocation(prepared);
export const desktopPreferences = () => facade().desktopPreferences();
export const exportDiagnostics = () => facade().exportDiagnostics();
export const testNotification = () => facade().testNotification();
export const scheduleElectronCacheCleanup = (schedule: boolean) => facade().scheduleElectronCacheCleanup(schedule);
export const openExternal = (url: string) => facade().openExternal(url);
export const openPluginsFolder = () => facade().openPluginsFolder();
export const openDirectory = (projectId: string, worktreeId?: string) => facade().openDirectory(projectId, worktreeId);
export const revealFileLocation = (target: import('@threadterm/protocol').FileLocationRequest) => facade().revealFileLocation?.(target) ?? Promise.reject(new Error('File location is unavailable'));
export const revealFile = (sessionId: string, path: string) => facade().revealFile?.(sessionId, path) ?? Promise.reject(new Error('File reveal is unavailable'));
export const openFileDefaultApp = (request: { projectId: string; worktreePath?: string; path: string } | { externalId: string }) => facade().openFileDefaultApp?.(request) ?? Promise.reject(new Error('Open with system app is unavailable'));
export const openInEditors = (refresh = false) => facade().openInEditors?.(refresh) ?? Promise.resolve([]);
export const openIn = (request: { editorId: string; projectId: string; worktreePath?: string; path?: string; line?: number }) => facade().openIn?.(request) ?? Promise.reject(new Error('Open in is unavailable'));
export const openWindow = (options: { sessionId?: string; workspaceId?: string }) => facade().openWindow(options);
export const windowAction = (action: "minimize" | "maximize" | "close") => facade().windowAction(action);
export const outputSubscription = (sessionId: string, cursor: number, listener: (chunk: OutputChunk) => void) => facade().subscribeOutput(sessionId, cursor, listener);
export const outputText = (chunk: OutputChunk) => new TextDecoder().decode(chunk.data);
export const operationId = () => crypto.randomUUID();
export const pickPageTarget = (request: Parameters<typeof window.threadterm.pickPageTarget>[0]) => facade().pickPageTarget(request);
export const cancelPagePick = (frameName: string) => facade().cancelPagePick(frameName);
export const markPageTarget = (request: Parameters<typeof window.threadterm.markPageTarget>[0]) => facade().markPageTarget(request);
export const inspectPageTarget = (request: Parameters<typeof window.threadterm.inspectPageTarget>[0]) => facade().inspectPageTarget(request);
export const readPageShot = (shotId: string) => facade().readPageShot(shotId);
export const deletePageShots = (shotIds: string[]) => facade().deletePageShots(shotIds);
export const onPageContextMenu = (listener: (value: { frameName: string; x: number; y: number; pick?: PagePick; staticFrame?: boolean; contextSequence?: number; selectionText: string }) => void) => facade().onPageContextMenu(listener);

/** Additive desktop capability; older/browser-only facades do not own native pages. */
const browserFacade = () => facade() as typeof window.threadterm & Partial<BrowserBridge>;
export function browserCommand(command: Extract<BrowserCommand,{type:'preferences'}>): Promise<BrowserPreferences>;
export function browserCommand(command: BrowserCommand): Promise<BrowserState|BrowserPreferences|void>;
export function browserCommand(command: BrowserCommand): Promise<BrowserState|BrowserPreferences|void> {
 return browserFacade().browserCommand?.(command) ?? Promise.reject(new Error('The built-in browser requires the desktop application.'));
}
export const onBrowserEvent = (listener:(event:BrowserEvent)=>void) => browserFacade().onBrowserEvent?.(listener) ?? (()=>{});
const browserHandoffFacade = () => facade() as typeof window.threadterm & Partial<BrowserHandoffBridge>;
export const browserHandoff = <C extends BrowserHandoffCommand>(command:C):Promise<BrowserHandoffResultFor<C>> => browserHandoffFacade().browserHandoff?.(command) ?? Promise.reject(new Error('The built-in browser requires the desktop application.'));
export const onBrowserHandoffEvent = (listener:(event:BrowserHandoffEvent)=>void) => browserHandoffFacade().onBrowserHandoffEvent?.(listener) ?? (()=>{});
export type { BrowserHandoffCommand, BrowserHandoffEvent, BrowserHandoffResult, BrowserHandoffResultFor } from '../../desktop/src/browser/handoffTypes';
export type { BrowserCommand, BrowserEvent, BrowserPreferences, BrowserState } from './browserTypes';

/** Additive desktop capability; the browser build serves no background images. */
export const backgroundBridge = (): Partial<BackgroundBridge> => facade() as typeof window.threadterm & Partial<BackgroundBridge>;
export type { BackgroundRecord, ImageStats } from '../../desktop/src/backgroundImagesCore';
