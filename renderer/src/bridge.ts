import type { ChatItem, Method, NativeHistoryItem, OutputChunk, ProviderId, RequestParams, RequestResult, RuntimeEvent, Snapshot } from "@threadterm/protocol";
export type { ChatItem, NativeHistoryItem, ProviderId, Snapshot } from "@threadterm/protocol";

function facade() { return window.threadterm; }
export const snapshot = () => facade().request("runtime.snapshot", {});
export const request = <M extends Method>(method: M, params: RequestParams<M>): Promise<RequestResult<M>> => facade().request(method, params);
export const subscribeEvents = (listener: (event: RuntimeEvent) => void) => facade().onEvent(listener);
export const onDesktopNavigate = (listener: (target: { sessionId?: string; workspaceId?: string; action?:"command-palette" }) => void) => facade().onDesktopNavigate(listener);
export const windowState = () => facade().windowState?.() ?? Promise.resolve({ maximized: false });
export const onWindowState = (listener: (state: { maximized: boolean }) => void) => facade().onWindowState?.(listener) ?? (() => {});
export const chooseDirectory = () => facade().chooseDirectory();
export const chooseSavePath = (kind: 'database' | 'settings' | 'theme') => facade().chooseSavePath(kind);
export const activateDataRelocation = (prepared: Awaited<ReturnType<typeof request<'data.relocation.prepare'>>>) => facade().activateDataRelocation(prepared);
export const desktopPreferences = () => facade().desktopPreferences();
export const exportDiagnostics = () => facade().exportDiagnostics();
export const testNotification = () => facade().testNotification();
export const scheduleElectronCacheCleanup = (schedule: boolean) => facade().scheduleElectronCacheCleanup(schedule);
export const openExternal = (url: string) => facade().openExternal(url);
export const openDirectory = (projectId: string, worktreeId?: string) => facade().openDirectory(projectId, worktreeId);
export const openWindow = (options: { sessionId?: string; workspaceId?: string }) => facade().openWindow(options);
export const windowAction = (action: "minimize" | "maximize" | "close") => facade().windowAction(action);
export const outputSubscription = (sessionId: string, cursor: number, listener: (chunk: OutputChunk) => void) => facade().subscribeOutput(sessionId, cursor, listener);
export const outputText = (chunk: OutputChunk) => new TextDecoder().decode(chunk.data);
export const operationId = () => crypto.randomUUID();
