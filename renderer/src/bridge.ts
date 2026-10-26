import type { BrowserBridge, BrowserCommand, BrowserEvent, BrowserPreferences, BrowserState } from './browserTypes';
import type { BrowserHandoffBridge, BrowserHandoffCommand, BrowserHandoffEvent, BrowserHandoffResult } from '../../desktop/src/browser/handoffTypes';
import type { PagePick, PageRect, PageTargetRef, ChatItem, Method, NativeHistoryItem, OutputChunk, ProviderId, RequestParams, RequestResult, RuntimeEvent, Snapshot } from "@threadterm/protocol";
export type { ChatItem, NativeHistoryItem, ProviderId, Snapshot } from "@threadterm/protocol";

function facade() { return window.threadterm; }
export const snapshot = () => facade().request("runtime.snapshot", {});
export const request = <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> => facade().request(method, params);
export const subscribeEvents = (listener: (event: RuntimeEvent) => void) => facade().onEvent(listener);
export const onDesktopNavigate = (listener: (target: { sessionId?: string; workspaceId?: string; action?:"command-palette" }) => void) => facade().onDesktopNavigate(listener);
export const windowState = () => facade().windowState?.() ?? Promise.resolve({ maximized: false });
export const onWindowState = (listener: (state: { maximized: boolean }) => void) => facade().onWindowState?.(listener) ?? (() => {});
export const chooseDirectory = () => facade().chooseDirectory();
export const attachFiles = () => facade().attachFiles();
export const openExternalFiles = () => facade().openExternalFiles();
export const chooseSavePath = (kind: 'database' | 'settings' | 'theme') => facade().chooseSavePath(kind);
export const exportFile = (kind: 'settings' | 'theme') => facade().exportFile(kind);
export const activateDataRelocation = (prepared: Awaited<ReturnType<typeof request<'data.relocation.prepare'>>>) => facade().activateDataRelocation(prepared);
export const desktopPreferences = () => facade().desktopPreferences();
export const exportDiagnostics = () => facade().exportDiagnostics();
export const testNotification = () => facade().testNotification();
export const scheduleElectronCacheCleanup = (schedule: boolean) => facade().scheduleElectronCacheCleanup(schedule);
export const openExternal = (url: string) => facade().openExternal(url);
export const openPluginsFolder = () => facade().openPluginsFolder();
export const openDirectory = (projectId: string, worktreeId?: string) => facade().openDirectory(projectId, worktreeId);
export const revealFile = (sessionId: string, path: string) => facade().revealFile?.(sessionId, path) ?? Promise.reject(new Error('File reveal is unavailable'));
export const openWindow = (options: { sessionId?: string; workspaceId?: string }) => facade().openWindow(options);
export const windowAction = (action: "minimize" | "maximize" | "close") => facade().windowAction(action);
export const outputSubscription = (sessionId: string, cursor: number, listener: (chunk: OutputChunk) => void) => facade().subscribeOutput(sessionId, cursor, listener);
export const outputText = (chunk: OutputChunk) => new TextDecoder().decode(chunk.data);
export const operationId = () => crypto.randomUUID();
export const pickPageTarget = (request: { frameName: string; frameRect: PageRect }) => facade().pickPageTarget(request);
export const cancelPagePick = (frameName: string) => facade().cancelPagePick(frameName);
export const markPageTarget = (request: { frameName: string; target?: PageTargetRef; flash?: boolean }) => facade().markPageTarget(request);
export const readPageShot = (shotId: string) => facade().readPageShot(shotId);
export const deletePageShots = (shotIds: string[]) => facade().deletePageShots(shotIds);
export const onPageContextMenu = (listener: (value: { frameName: string; x: number; y: number; pick?: PagePick; staticFrame?: boolean; selectionText: string }) => void) => facade().onPageContextMenu(listener);

/** Additive desktop capability; older/browser-only facades do not own native pages. */
const browserFacade = () => facade() as typeof window.threadterm & Partial<BrowserBridge>;
export function browserCommand(command: Extract<BrowserCommand,{type:'preferences'}>): Promise<BrowserPreferences>;
export function browserCommand(command: BrowserCommand): Promise<BrowserState|BrowserPreferences|void>;
export function browserCommand(command: BrowserCommand): Promise<BrowserState|BrowserPreferences|void> {
 return browserFacade().browserCommand?.(command) ?? Promise.reject(new Error('The built-in browser requires the desktop application.'));
}
export const onBrowserEvent = (listener:(event:BrowserEvent)=>void) => browserFacade().onBrowserEvent?.(listener) ?? (()=>{});
const browserHandoffFacade = () => facade() as typeof window.threadterm & Partial<BrowserHandoffBridge>;
export const browserHandoff = (command:BrowserHandoffCommand):Promise<BrowserHandoffResult> => browserHandoffFacade().browserHandoff?.(command) ?? Promise.reject(new Error('The built-in browser requires the desktop application.'));
export const onBrowserHandoffEvent = (listener:(event:BrowserHandoffEvent)=>void) => browserHandoffFacade().onBrowserHandoffEvent?.(listener) ?? (()=>{});
export type { BrowserHandoffCommand, BrowserHandoffEvent, BrowserHandoffResult } from '../../desktop/src/browser/handoffTypes';
export type { BrowserCommand, BrowserEvent, BrowserPreferences, BrowserState } from './browserTypes';
