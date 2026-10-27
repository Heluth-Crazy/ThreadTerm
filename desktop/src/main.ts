import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, globalShortcut, Notification, screen, session, protocol, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { canonicalRelocationPath } from './relocationPaths.js';
import { readFileSync, renameSync, writeFileSync, unlinkSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { validateRequest, type Method, type RequestParams, type RuntimeEvent } from '@threadterm/protocol';
import { RuntimeClient, RuntimeRequestError, runtimePipeIsOpen, waitForPendingRuntimeStartup } from './runtime-client.js';
import { floatIdentity, nextFloatKey, tiledFloatBounds, type FloatMode } from './floatingWindows.js';
import { nativeDelivery, type NotificationKind } from './notificationPreferences.js';
import { inboxNotificationCopy, notificationLocale, terminalNotificationCopy, terminalNotificationKind, testNotificationCopy, type InboxNotice, type NotificationLocale } from './inboxNotification.js';
import { ignoreBrokenStdio, isBrokenPipeError } from './stdioGuards.js';
import { resolveWindowChrome } from './windowChrome.js';
import { terminalWindowArguments } from './terminalEnvironment.js';
import { registerPageComments } from './pageComments.js';
import { registerBrowser } from './browser/index.js';
import { nativeMarkdownExportFiles, saveChatMarkdown, writeChatMarkdownAtomic } from './chatMarkdownExport.js';
import { applicationIconPng, trayIconPng } from '../assets/icon-data.js';
import { quitConfirmationOptions, quitConfirmationPreapproved } from './quitConfirmation.js';
import { deletedRevealScope, isWithinScope, revealTarget } from './revealFile.js';
import { qaAttachPathsOverride, readAttachFiles } from './attachFiles.js';
import { qaOpenExternalPathsOverride } from './externalFiles.js';

import { HtmlPreviewGrantManager, registerHtmlPreviewScheme, mergePreviewIsolationFeatures, installHtmlPreviewSession, attachHtmlPreviewWindow } from './htmlPreview.js';
import { registerHtmlPreviewIpc } from './htmlPreviewIpc.js';
import { backgroundImagesFolder, installBackgroundImageSession, registerBackgroundImageIpc, registerBackgroundImageScheme } from './backgroundImages.js';
import { buildThemeExport, importThemePackImages, qaThemeExportOverride } from './themePackCore.js';
import { appCspForHtml, buildAppCsp } from './appCsp.js';

registerHtmlPreviewScheme(protocol);
registerBackgroundImageScheme(protocol);
app.commandLine.appendSwitch('enable-features', mergePreviewIsolationFeatures(app.commandLine.getSwitchValue('enable-features')));
const htmlPreviewGrants = new HtmlPreviewGrantManager();
let htmlPreviewPreloadReady = false;

ignoreBrokenStdio();
process.on('uncaughtException', (error) => {
  if (isBrokenPipeError(error)) return;
  try {
    dialog.showErrorBox('A JavaScript error occurred in the main process', error instanceof Error ? (error.stack ?? error.message) : String(error));
  } catch { /* stdout may already be gone */ }
});

let adminRuntime = createAdminRuntime();
const windowRuntimes = new Map<number, RuntimeClient>();
const outputSubscriptions = new Map<string, { ownerId: number; unsubscribe?: () => void; acknowledgements: Array<() => void> }>();
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let allowQuit = false;
let quitPending = false;
let stoppingRuntime = false;
let lastSessionId: string | undefined;
let lastNotificationSeq = 0;
let lightweightMode = false;
let floatMode: FloatMode = 'manual';
const floatingWindows = new Map<string, BrowserWindow>();
let activeFloatKey: string | undefined;
const windowChrome = resolveWindowChrome(process.platform, release(), process.env.THREADTERM_V3_WINDOW_CHROME);

app.setName('ThreadTerm');
// Windows attributes toasts to an AppUserModelID: the installer's Start-menu shortcut carries build.appId
// (package.json); an unpackaged run uses its executable path.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.threadterm.v3' : process.execPath);
// Test-only isolated Electron profile. Production launchers never set this.
if (process.env.THREADTERM_V3_USER_DATA) app.setPath('userData', process.env.THREADTERM_V3_USER_DATA);
if (!app.isPackaged && process.env.THREADTERM_V3_USER_DATA && process.env.THREADTERM_V3_BROWSER_QA_DOWNLOADS) app.setPath('downloads', process.env.THREADTERM_V3_BROWSER_QA_DOWNLOADS);
app.on('window-all-closed', () => undefined);
app.on('before-quit', (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
app.on('will-quit', () => { adminRuntime.dispose(); for (const client of windowRuntimes.values()) client.dispose(); });

void app.whenReady().then(async () => {
  installAppCspHeader(session.defaultSession);
  installHtmlPreviewSession(session.defaultSession, htmlPreviewGrants, { appFrameAncestor: process.env.THREADTERM_V3_DEV_SERVER_URL ? new URL(process.env.THREADTERM_V3_DEV_SERVER_URL).origin : 'file:' });
  installBackgroundImageSession(session.defaultSession, backgroundImagesFolder());
  try {
    const preloadPath = join(__dirname, 'htmlPreviewSandboxPreload.cjs');
    if (!statSync(preloadPath).isFile()) throw new Error('Missing HTML preview safety preload');
    session.defaultSession.registerPreloadScript({ type: 'frame', filePath: preloadPath });
    htmlPreviewPreloadReady = true;
  } catch { /* Preview grants fail closed when the safety asset is unavailable. */ }
  registerIpc();
  // The window and its launch screen come up at once and cover the runtime start. A scheduled cache cleanup needs
  // the runtime's settings, so it runs alongside instead of keeping the window back until the runtime answers.
  mainWindow = createWindow();
  createTray();
  void refreshDesktopPreferences();
  await runScheduledElectronCacheCleanup();
});

function createAdminRuntime(): RuntimeClient {
  const client = new RuntimeClient();
  attachAdminRuntime(client);
  return client;
}
function attachAdminRuntime(client: RuntimeClient): void {
  client.onEvent((event) => {
    if (stoppingRuntime) return;
    if (event.event === 'presentation.requested') presentRuntimeSession(event.data);
    // Settings are persisted as a state.changed outbox event, never as an
    // invented "settings" transport event. Refresh immediately so shortcut
    // registration and floating-window preference follow the confirmed state.
    if (event.event === 'state.changed' && stateChangeKind(event.data) === 'settings') void refreshDesktopPreferences();
    if (event.seq <= lastNotificationSeq) return;
    if (event.event === 'session.status') void notifyTerminalCompletion(event);
    // Chat projection emits inbox.created once per durable attention item.
    // Terminal completion stays on session.status because its inbox record is
    // intentionally resolved and does not emit inbox.created.
    if (event.event === 'inbox.created' && isInboxNotification(event.data)) {
      lastNotificationSeq = event.seq;
      void presentInboxNotification(event.data);
    }
  });
}
function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const devUrl = process.env.THREADTERM_V3_DEV_SERVER_URL;
    if (devUrl) return url.origin === new URL(devUrl).origin;
    return url.protocol === 'file:' && fileURLToPath(url) === join(__dirname, 'renderer', 'index.html');
  } catch { return false; }
}
/** A CSP header for the app document, alongside the meta tag the renderer build carries (desktop/src/appCsp.ts):
 *  page code cannot drop a header, and it applies before the first byte of the body is parsed. The document's own
 *  file supplies the script hashes, so the header and the built meta tag always agree. */
function installAppCspHeader(appSession: Electron.Session): void {
  const devUrl = process.env.THREADTERM_V3_DEV_SERVER_URL;
  const urls = ['file:///*'];
  if (devUrl) {
    try { urls.push(`${new URL(devUrl).origin}/*`); } catch { return; }
  }
  let policy: string;
  if (devUrl) policy = buildAppCsp([], { dev: true });
  else {
    try { policy = appCspForHtml(readFileSync(join(__dirname, 'renderer', 'index.html'), 'utf8')); }
    catch { return; }
  }
  appSession.webRequest.onHeadersReceived({ urls }, (details, callback) => {
    // A document is a mainFrame, or a subFrame when something embeds it; the header has to cover both, because
    // frame-ancestors is what stops the app document being framed at all.
    if (!['mainFrame', 'subFrame'].includes(details.resourceType) || !isTrustedRendererUrl(details.url)) { callback({}); return; }
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
}
function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url)) throw new Error('Untrusted renderer IPC sender');
}
function trayImage(): Electron.NativeImage {
  return nativeImage.createFromDataURL(trayIconPng);
}
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function createWindow(options: { sessionId?: string; workspaceId?: string; floating?: boolean; background?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: options.floating ? 900 : 1440,
    height: options.floating ? 640 : 920,
    minWidth: options.floating ? 520 : 960,
    minHeight: options.floating ? 400 : 640,
    show: false,
    icon: nativeImage.createFromDataURL(applicationIconPng),
    frame: false,
    titleBarStyle: 'hidden',
    // Windows 11 rounds the opaque window natively (DWM, `roundedCorners`);
    // older Windows cannot, so the window is transparent and the renderer
    // rounds .app-shell in CSS (see resolveWindowChrome, chrome= query param).
    ...(windowChrome === 'native' ? { roundedCorners: true } : { transparent: true }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      webSecurity: true,
      additionalArguments: terminalWindowArguments(process.platform, release()),
    },
  });
  // The taskbar group has a separate icon source from WM_GETICON. Bind it to
  // this packaged executable instead of relying on a matching old shortcut.
  if (process.platform === 'win32' && app.isPackaged) {
    window.setAppDetails({ appId: 'com.threadterm.v3', appIconPath: process.execPath, appIconIndex: 0 });
  }
  const emitWindowState = () => { if (!window.isDestroyed()) window.webContents.send('threadterm:window-state', { maximized: window.isMaximized() }); };
  window.on('maximize', emitWindowState);
  window.on('unmaximize', emitWindowState);
  window.once('ready-to-show', () => { if (options.background) window.showInactive(); else window.show(); });
  attachHtmlPreviewWindow(window, htmlPreviewGrants, { forwardLink: (frameName, url, grantId) => window.webContents.send('threadterm:html-preview-link', { frameName, url, grantId }) });
  window.webContents.on('will-navigate', (event, target) => { if (!isTrustedRendererUrl(target)) event.preventDefault(); });
  if (options.floating) window.setAlwaysOnTop(true, 'floating');
  if (options.sessionId) lastSessionId = options.sessionId;
  window.on('close', (event) => {
    if (!allowQuit && !options.floating) { event.preventDefault(); window.hide(); }
  });
  void loadRenderer(window, options);
  return window;
}

async function loadRenderer(window: BrowserWindow, options: { sessionId?: string; workspaceId?: string; floating?: boolean }): Promise<void> {
  const query = new URLSearchParams();
  if (options.sessionId) query.set('sessionId', options.sessionId);
  if (options.workspaceId) query.set('workspaceId', options.workspaceId);
  if (options.floating) query.set('floating', '1');
  if (windowChrome === 'native') query.set('chrome', 'native');
  const suffix = query.toString();
  const devUrl = process.env.THREADTERM_V3_DEV_SERVER_URL;
  if (devUrl) await window.loadURL(`${devUrl}${suffix ? `?${suffix}` : ''}`);
  else await window.loadFile(join(__dirname, 'renderer', 'index.html'), { query: Object.fromEntries(query) });
}

function presentRuntimeSession(data: unknown): void {
  if (!isPresentationRequest(data)) return;
  if (data.placement === 'window' && !lightweightMode) {
    openFloatingWindow({ sessionId: data.sessionId, background: data.presentation === 'background' });
    return;
  }
  if (data.presentation === 'focused') showMainWindow();
  mainWindow?.webContents.send('threadterm:presentation-requested', data);
}
function isPresentationRequest(value: unknown): value is { sessionId: string; placement: 'workspace'|'window'; presentation: 'background'|'focused'; workspacePath?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return typeof data.sessionId === 'string' && (data.placement === 'workspace' || data.placement === 'window') && (data.presentation === 'background' || data.presentation === 'focused') && (data.workspacePath === undefined || typeof data.workspacePath === 'string');
}

function createTray(): void {
  const image = trayImage();
  if (image.isEmpty()) throw new Error('ThreadTerm tray icon could not be created');
  tray = new Tray(image);
  tray.setToolTip('ThreadTerm');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show ThreadTerm', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { void requestQuit(); } },
  ]));
  tray.on('click', () => showMainWindow());
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
}

async function refreshDesktopPreferences(): Promise<{ shortcuts: Record<string, string> }> {
  const snapshot = await adminRuntime.request('runtime.snapshot', {});
  const settings = snapshot.settings;
  lightweightMode = settings.lightweightMode === true;
  const shortcuts = settings.shortcuts && typeof settings.shortcuts === 'object' ? settings.shortcuts as Record<string, unknown> : {};
  globalShortcut.unregisterAll();
  const result: Record<string, string> = {};
  floatMode = settings.floatMode === 'tile' || settings.floatMode === 'cycle' ? settings.floatMode : 'manual';
  for (const [key, action] of Object.entries({ showMainWindow: () => {showMainWindow();mainWindow?.webContents.send("threadterm:desktop-navigate",{action:"command-palette"});}, floatLastSession: () => { if (lightweightMode) { if (lastSessionId) routeMainWindow({ sessionId: lastSessionId }); else showMainWindow(); } else if (!(floatMode === 'cycle' && focusNextFloatingWindow()) && lastSessionId) openFloatingWindow({ sessionId: lastSessionId }); } })) {
    const accelerator = shortcuts[key] ?? (key === 'showMainWindow' ? 'CommandOrControl+Shift+Space' : 'CommandOrControl+Shift+O');
    if (typeof accelerator !== 'string' || !accelerator) { result[key] = 'disabled'; continue; }
    try { result[key] = globalShortcut.register(accelerator, action) ? 'registered' : 'unavailable'; } catch { result[key] = 'invalid'; }
  }
  return { shortcuts: result };
}
function isTerminalCompletion(value: unknown): value is { sessionId: string; status: string } { return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).sessionId === 'string' && ['exited', 'error', 'interrupted'].includes(String((value as Record<string, unknown>).status)); }
async function notifyTerminalCompletion(event: RuntimeEvent): Promise<void> {
  const completion = event.data;
  if (!isTerminalCompletion(completion) || event.seq <= lastNotificationSeq) return;
  try {
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    const session = snapshot.sessions.find((item) => item.id === completion.sessionId);
    if (session?.mode !== 'terminal') return;
    if (event.seq <= lastNotificationSeq) return;
    lastNotificationSeq = event.seq;
    const exitCode = (completion as { exitCode?: unknown }).exitCode;
    const notice = { status: completion.status, exitCode: typeof exitCode === 'number' ? exitCode : session.exitCode, title: session.title, provider: session.provider, providerName: snapshot.providers.find((provider) => provider.id === session.provider)?.name };
    void notifyNative(terminalNotificationKind(notice), (locale) => terminalNotificationCopy(notice, locale), { sessionId: completion.sessionId });
  } catch { /* A later inbox event remains the authoritative chat notification. */ }
}
function stateChangeKind(value: unknown): string | undefined { return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).kind === 'string' ? (value as Record<string, unknown>).kind as string : undefined; }
function isInboxNotification(value: unknown): value is InboxNotice { const kind = stateChangeKind(value); return kind === 'approval' || kind === 'reply' || kind === 'error' || kind === 'waiting'; }
function inboxNoticeFromEvent(value: InboxNotice): InboxNotice {
  return { kind: value.kind, sessionId: value.sessionId, title: value.title, provider: value.provider, providerName: value.providerName };
}
function inboxNotificationKind(value: InboxNotice): NotificationKind { return value.kind === 'reply' ? 'completed' : 'attention'; }
async function presentInboxNotification(value: InboxNotice): Promise<void> {
  let notice = inboxNoticeFromEvent(value);
  try {
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    const session = notice.sessionId ? snapshot.sessions.find((item) => item.id === notice.sessionId) : undefined;
    if (session) notice = { ...notice, title: notice.title || session.title, provider: notice.provider || session.provider, providerName: snapshot.providers.find((provider) => provider.id === session.provider)?.name };
  } catch { /* Kind-only payload is still enough to notify. */ }
  void notifyNative(inboxNotificationKind(notice), (locale) => inboxNotificationCopy(notice, locale), { sessionId: notice.sessionId });
}
/** Recent notifications stay referenced, so a click (also later from the Action Center) still reaches its handler. */
const recentNotifications: Notification[] = [];
/** Shows an OS notification for a session event or a Settings test, as nativeDelivery decides, in the app language.
 * A click brings ThreadTerm forward on the session. Never throws: session events arrive via the admin runtime's
 * event handler. Resolves once Windows has shown the toast (or reported it failed). */
async function notifyNative(kind: NotificationKind, copy: (locale: NotificationLocale) => { title: string; body: string }, options: { sessionId?: string; test?: boolean } = {}): Promise<{ sent: boolean; reason?: string }> {
  let locale: NotificationLocale = 'en';
  try {
    const { settings } = await adminRuntime.request('runtime.snapshot', {});
    locale = notificationLocale(settings);
    const zh = locale === 'zh-CN';
    if (!Notification.isSupported()) return { sent: false, reason: zh ? '此系统不支持系统通知。' : 'This system does not support native notifications.' };
    // A minimized or tray-hidden window can still report focus on Windows; neither is the user looking at ThreadTerm.
    const focused = BrowserWindow.getFocusedWindow();
    const delivery = nativeDelivery(settings.notifications, kind, { appFocused: !!focused && focused.isVisible() && !focused.isMinimized(), test: options.test });
    if (!delivery.deliver) return { sent: false, reason: delivery.reason === 'disabled' ? (zh ? '请先开启“允许系统通知”。' : 'Turn on "Allow system notifications" first.') : delivery.reason };
    const notification = new Notification({ ...copy(locale), silent: delivery.silent });
    recentNotifications.push(notification);
    if (recentNotifications.length > 20) recentNotifications.shift();
    notification.on('click', () => { if (options.sessionId) routeMainWindow({ sessionId: options.sessionId }); else showMainWindow(); });
    const shown = new Promise<{ sent: boolean; reason?: string }>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise({ sent: true }), 4000);
      notification.once('show', () => { clearTimeout(timer); resolvePromise({ sent: true }); });
      notification.once('failed', (_event, error) => { clearTimeout(timer); resolvePromise({ sent: false, reason: error }); });
    });
    notification.show();
    return await shown;
  } catch { return { sent: false, reason: locale === 'zh-CN' ? '暂时无法读取通知设置。' : 'Notification settings are unavailable right now.' }; }
}

function registerIpc(): void {
  registerBrowser(event => {
    assertTrustedRenderer(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('Browser commands require the application main frame');
  },event=>{
    const runtime=runtimeFor(event);
    return {browserRequest:(method,params)=>runtime.browserRequest(method,params),onBrowserFrame:listener=>runtime.onBrowserFrame(listener),onBrowserDisconnect:listener=>runtime.onBrowserDisconnect(listener),onEvent:listener=>runtime.onEvent(listener),snapshot:()=>runtime.request('runtime.snapshot',{})};
  });
  registerHtmlPreviewIpc(htmlPreviewGrants, assertTrustedRenderer, runtimeFor, () => htmlPreviewPreloadReady);
  registerBackgroundImageIpc({ folder: backgroundImagesFolder(), assertTrusted: assertTrustedRenderer, isPackaged: app.isPackaged });
  registerPageComments(assertTrustedRenderer, async after => {
    const references = await adminRuntime.request('reviewDrafts.assetReferences', after ? { after, limit: 200 } : { limit: 200 });
    return { paths: references.paths, nextAfter: references.nextAfter, legacyImportComplete: references.legacyImportComplete };
  });
  ipcMain.handle('threadterm:export-chat-markdown', (event, payload: unknown) => saveChatMarkdown(event, payload, {
    assertTrusted: assertTrustedRenderer,
    choosePath: async options => { const owner = BrowserWindow.fromWebContents(event.sender); return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options); },
    write: writeChatMarkdownAtomic,
    files: nativeMarkdownExportFiles,
    alive: () => !event.sender.isDestroyed(),
  }));
  ipcMain.handle('threadterm:request', async (event, method: unknown, params: unknown) => {
    assertTrustedRenderer(event);
    validateRequest(method, params);
    const runtime = runtimeFor(event);
    if (method === 'data.backup') await session.defaultSession.flushStorageData();
    const requestParams = method === 'data.backup' ? { ...params as RequestParams<'data.backup'>, desktopDataRoot: app.getPath('userData') } : params;
    return runtime.request(method, requestParams as RequestParams<Method>);
  });
  ipcMain.handle('threadterm:qa-drop-control', (event) => {
    assertTrustedRenderer(event);
    if (process.env.THREADTERM_V3_RELOCATION_QA !== '1' || app.isPackaged) throw new Error('QA control drop is unavailable');
    if (!runtimeFor(event).dropControlForQa()) throw new Error('Runtime control pipe is unavailable');
  });
  ipcMain.handle('threadterm:qa-resume-control', (event) => {
    assertTrustedRenderer(event);
    if (process.env.THREADTERM_V3_RELOCATION_QA !== '1' || app.isPackaged) throw new Error('QA control resume is unavailable');
    if (!runtimeFor(event).resumeControlForQa()) throw new Error('Runtime control pipe is not paused');
  });
  ipcMain.handle('threadterm:qa-fail-chat-projection', (event, sessionId: unknown) => {
    assertTrustedRenderer(event);
    if (process.env.THREADTERM_V3_RELOCATION_QA !== '1' || app.isPackaged) throw new Error('QA projection failure is unavailable');
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('Invalid QA session');
    return runtimeFor(event).failChatProjectionForQa(sessionId);
  });
  ipcMain.handle('threadterm:subscribe-output', async (event, sessionId: unknown, cursor: unknown, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(cursor) || Number(cursor) < 0 || typeof id !== 'string' || !id) throw new Error('Invalid output subscription');
    const outputCursor = Number(cursor);
    outputSubscriptions.set(id, { ownerId: event.sender.id, acknowledgements: [] });
    let unsubscribe: () => void;
    try {
      unsubscribe = await runtimeFor(event).subscribeOutput(sessionId, outputCursor, (chunk) => new Promise<void>((resolvePromise) => {
        if (event.sender.isDestroyed()) { resolvePromise(); return; }
        const subscription = outputSubscriptions.get(id);
        if (!subscription) { resolvePromise(); return; }
        subscription.acknowledgements.push(resolvePromise);
        event.sender.send('threadterm:output', { id, chunk });
      }));
    } catch (error) { closeOutputSubscription(id); throw error; }
    const subscription = outputSubscriptions.get(id);
    if (!subscription) { unsubscribe(); throw new Error('Output subscription was cancelled'); }
    subscription.unsubscribe = unsubscribe;
    event.sender.once('destroyed', () => closeOutputSubscription(id));
    return { id };
  });
  ipcMain.handle('threadterm:unsubscribe-output', (event, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id === 'string' && outputSubscriptions.get(id)?.ownerId === event.sender.id) closeOutputSubscription(id);
  });
  ipcMain.handle('threadterm:ack-output', (event, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof id === 'string') { const subscription = outputSubscriptions.get(id); if (subscription?.ownerId === event.sender.id) subscription.acknowledgements.shift()?.(); }
  });
  ipcMain.handle('threadterm:choose-directory', async (event) => {
    assertTrustedRenderer(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory', 'createDirectory'] as Electron.OpenDialogOptions['properties'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('threadterm:attach-files', async (event) => {
    assertTrustedRenderer(event);
    // QA can point the picker at fixture paths so the real app never opens a native dialog.
    const qaPaths = qaAttachPathsOverride(process.env.THREADTERM_V3_ATTACH_FILES_QA, app.isPackaged);
    if (qaPaths) return readAttachFiles(qaPaths);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: 'Attach files', properties: ['openFile', 'multiSelections'] as Electron.OpenDialogOptions['properties'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : readAttachFiles(result.filePaths);
  });
  ipcMain.handle('threadterm:open-external-files', async (event) => {
    assertTrustedRenderer(event);
    const qaPaths = qaOpenExternalPathsOverride(process.env.THREADTERM_V3_OPEN_EXTERNAL_QA, app.isPackaged);
    if (qaPaths) return qaPaths;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: 'Open file outside workspace', properties: ['openFile', 'multiSelections'] as Electron.OpenDialogOptions['properties'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('threadterm:activate-data-relocation', async (event, prepared: unknown) => { assertTrustedRenderer(event); return activateDataRelocation(prepared); });
  ipcMain.handle('threadterm:choose-save-path', async (event, kind: unknown) => {
    assertTrustedRenderer(event);
    if (kind !== 'database' && kind !== 'settings' && kind !== 'theme') throw new Error('Unsupported save kind');
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: kind === 'database' ? 'Back up ThreadTerm data' : 'Save ThreadTerm settings',
      defaultPath: kind === 'database' ? `threadterm-v3-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite3` : `threadterm-v3-${kind}.json`,
      filters: kind === 'database' ? [{ name: 'SQLite database', extensions: ['sqlite3'] }] : [{ name: 'JSON', extensions: ['json'] }],
    } satisfies Electron.SaveDialogOptions;
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    return result.canceled ? null : (result.filePath ?? null);
  });
  ipcMain.handle('threadterm:export-file', async (event, kind: unknown) => {
    assertTrustedRenderer(event);
    if (kind !== 'settings' && kind !== 'theme') throw new Error('Unsupported export kind');
    const content = kind === 'settings' ? await adminRuntime.request('settings.export', {}) : (await adminRuntime.request('runtime.snapshot', {})).settings.customThemes;
    if (kind === 'theme' && (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).length === 0)) throw new Error('There are no custom themes to export');
    // A theme that carries background images exports them inside the pack; a palette-only export stays plain JSON.
    const exported = kind === 'theme' ? await buildThemeExport(backgroundImagesFolder(), content) : undefined;
    if (exported?.missing.length) console.warn(`Theme export skipped ${exported.missing.length} background image(s) missing from the store`);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: kind === 'settings' ? 'Save ThreadTerm settings' : 'Export ThreadTerm themes',
      defaultPath: kind === 'settings' ? 'threadterm-v3-settings.json' : 'threadterm-v3-themes.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    } satisfies Electron.SaveDialogOptions;
    // QA points the theme export at a fixture path so the real app never opens a native save dialog.
    const qaPath = kind === 'theme' ? qaThemeExportOverride(process.env.THREADTERM_V3_EXPORT_THEME_QA, app.isPackaged) : undefined;
    const saved = qaPath ? { canceled: false, filePath: qaPath } : owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (saved.canceled || !saved.filePath) return null;
    writeFileSync(saved.filePath, JSON.stringify(exported ? exported.pack : content, null, 2) + '\n');
    return { path: saved.filePath, missingImages: exported?.missing ?? [] };
  });
  ipcMain.handle('threadterm:theme-pack-import-images', async (event, images: unknown) => {
    assertTrustedRenderer(event);
    return importThemePackImages(backgroundImagesFolder(), images);
  });
  ipcMain.handle('threadterm:window-action', async (event, action: unknown) => { assertTrustedRenderer(event); return windowAction(event, action); });
  ipcMain.handle('threadterm:window-state', (event) => { assertTrustedRenderer(event); return { maximized: BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false }; });
  ipcMain.handle('threadterm:open-window', async (_event, options: unknown) => {
    assertTrustedRenderer(_event);
    if (!isWindowOptions(options)) throw new Error('Invalid window options');
    openFloatingWindow(options);
  });
  ipcMain.handle('threadterm:desktop-preferences', async (event) => { assertTrustedRenderer(event); return refreshDesktopPreferences(); });
  ipcMain.handle('threadterm:open-directory', async (event, projectId: unknown, worktreeId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof projectId !== 'string' || !projectId) throw new Error('Invalid project');
    const data = await adminRuntime.request('runtime.snapshot', {});
    const project = data.projects.find(item => item.id === projectId);
    if (!project) throw new Error('Project directory is unavailable');
    let directory = project.path;
    if (worktreeId !== undefined) {
      if (typeof worktreeId !== 'string' || !worktreeId) throw new Error('Invalid worktree');
      const trees = await adminRuntime.request('worktree.list', { projectId });
      const tree = trees.find(item => item.id === worktreeId && item.projectId === projectId);
      if (!tree || tree.missing) throw new Error('Worktree directory is unavailable');
      directory = tree.path;
    }
    if (!statSync(directory).isDirectory()) throw new Error('Directory is unavailable');
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  ipcMain.handle('threadterm:reveal-file', async (event, sessionId: unknown, path: unknown) => {
    assertTrustedRenderer(event);
    if (!isRevealSessionId(sessionId) || !isRevealPath(path)) throw new Error('Invalid file reveal request');
    let target: { scope: string; path: string };
    try {
      const resolved = await adminRuntime.request('filesystem.resolve', { sessionId, path });
      if (!resolved.worktreePath) throw new Error('File project scope is unavailable');
      target = revealTarget(resolved, realpathSync(resolved.worktreePath));
    } catch (error) {
      if (!(error instanceof RuntimeRequestError) || error.code !== 'file_reference_not_found') throw error;
      const scope = deletedRevealScope(await adminRuntime.request('runtime.snapshot', {}), sessionId);
      target = revealTarget({ worktreePath: scope, path }, realpathSync(scope));
    }
    try {
      const canonicalFile = realpathSync(target.path);
      if (!isWithinScope(target.scope, canonicalFile)) throw new Error('File is outside its project scope');
      shell.showItemInFolder(canonicalFile);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const openError = await shell.openPath(canonicalExistingParent(target.scope, target.path));
      if (openError) throw new Error(openError);
    }
  });
  ipcMain.handle('threadterm:open-plugins-folder', async (event) => {
    assertTrustedRenderer(event);
    const { directory } = await adminRuntime.request('plugin.list', {});
    mkdirSync(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  ipcMain.handle('threadterm:export-diagnostics', async (event) => { assertTrustedRenderer(event); const owner=BrowserWindow.fromWebContents(event.sender); const saved=owner?await dialog.showSaveDialog(owner,{defaultPath:'threadterm-v3-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]}):await dialog.showSaveDialog({defaultPath:'threadterm-v3-diagnostics.json'}); if(saved.canceled||!saved.filePath)return null; const snapshot=await adminRuntime.request('runtime.snapshot',{}); const health=await adminRuntime.request('runtime.health',{}); const report={version:app.getVersion(),platform:process.platform,runtime:health,counts:{projects:snapshot.projects.length,sessions:snapshot.sessions.length,providers:snapshot.providers.length},providers:snapshot.providers.map(p=>({id:p.id,installed:p.installed,version:p.version,terminal:p.terminal,chat:p.chat}))}; writeFileSync(saved.filePath,JSON.stringify(report,null,2)); return saved.filePath; });
  ipcMain.handle('threadterm:test-notification', async (event) => { assertTrustedRenderer(event); return notifyNative('attention', testNotificationCopy, { test: true }); });
  ipcMain.handle('threadterm:schedule-electron-cache-cleanup', async (event, schedule: unknown) => {
    assertTrustedRenderer(event);
    if (typeof schedule !== 'boolean') throw new Error('Invalid cleanup schedule');
    if (process.platform !== 'win32') return { scheduled: false, available: false, result: 'Cache cleanup is available on Windows only.' };
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    await adminRuntime.request('settings.update', { patch: { electronCacheCleanup: schedule ? { state: 'scheduled', scheduledAt: new Date().toISOString() } : null }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    return { scheduled: schedule, available: true };
  });
  ipcMain.handle('threadterm:open-external', async (_event, url: unknown) => {
    assertTrustedRenderer(_event);
    if (typeof url !== 'string') throw new Error('Invalid external URL');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only HTTP(S) external URLs are allowed');
    await shell.openExternal(parsed.toString());
  });
}

function openFloatingWindow(options: { sessionId?: string; workspaceId?: string; background?: boolean }): void {
  if (lightweightMode) { routeMainWindow(options); return; }
  const key = floatIdentity(options);
  const existing = key ? floatingWindows.get(key) : undefined;
  if (existing && !existing.isDestroyed()) {
    activeFloatKey = key;
    existing.show();
    existing.focus();
    return;
  }
  const window = createWindow({ ...options, floating: true });
  if (key) {
    floatingWindows.set(key, window);
    activeFloatKey = key;
    window.on('focus', () => { activeFloatKey = key; });
    window.once('closed', () => {
      if (floatingWindows.get(key) === window) floatingWindows.delete(key);
      if (activeFloatKey === key) activeFloatKey = undefined;
    });
  }
  if (floatMode === 'tile') tileFloatingWindows();
}

function routeMainWindow(options: { sessionId?: string; workspaceId?: string }): void {
  showMainWindow();
  mainWindow?.webContents.send('threadterm:desktop-navigate', options);
}

function focusNextFloatingWindow(): boolean {
  const keys = [...floatingWindows.entries()]
    .filter(([, window]) => !window.isDestroyed())
    .map(([key]) => key);
  const next = nextFloatKey(keys, activeFloatKey);
  const window = next ? floatingWindows.get(next) : undefined;
  if (!next || !window || window.isDestroyed()) return false;
  activeFloatKey = next;
  window.show();
  window.focus();
  return true;
}

function tileFloatingWindows(): void {
  const windows = [...floatingWindows.values()].filter((window) => !window.isDestroyed());
  if (!windows.length) return;
  const point = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : windows[0].getBounds();
  const area = screen.getDisplayNearestPoint({ x: point.x, y: point.y }).workArea;
  tiledFloatBounds(area, windows.length).forEach((bounds, index) => windows[index]?.setBounds(bounds));
}

async function runScheduledElectronCacheCleanup(): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    const scheduled = snapshot.settings.electronCacheCleanup as { state?: unknown; scheduledAt?: unknown } | null | undefined;
    if (scheduled?.state !== 'scheduled' || typeof scheduled.scheduledAt !== 'string') return;
    let result: Record<string, string>;
    try {
      await session.defaultSession.clearCache();
      result = { state: 'completed', completedAt: new Date().toISOString() };
    } catch (error) {
      result = { state: 'failed', failedAt: new Date().toISOString(), message: String(error).slice(0, 2048) };
    }
    const current = await adminRuntime.request('runtime.snapshot', {});
    const currentSchedule = current.settings.electronCacheCleanup as { state?: unknown; scheduledAt?: unknown } | null | undefined;
    if (currentSchedule?.state === 'scheduled' && currentSchedule.scheduledAt === scheduled.scheduledAt) {
      await adminRuntime.request('settings.update', { patch: { electronCacheCleanup: result }, expectedRevision: current.settings.revision, operationId: randomUUID() });
    }
  } catch (error) { console.error('Scheduled cache cleanup could not be recorded', error); }
}

async function activateDataRelocation(value: unknown): Promise<{ activated: boolean }> {
  if (process.env.THREADTERM_V3_DATA) throw new Error('Data relocation is unavailable while THREADTERM_V3_DATA overrides the active data root');
  if (!isPreparedRelocation(value)) throw new Error('Invalid prepared relocation');
  const targetRoot = canonicalPath(value.targetRoot);
  const ready = JSON.parse(readFileSync(join(targetRoot, 'relocation.ready.json'), 'utf8')) as unknown;
  if (!isPreparedRelocation(ready) || canonicalPath(ready.targetRoot) !== targetRoot || ready.activationToken !== value.activationToken) throw new Error('Relocation preparation is not valid');
  const pointer = join(app.getPath('userData'), 'runtime-data-root.json');
  const priorPointer = readPointer(pointer);
  const sourceRoot = canonicalPath(value.sourceRoot);
  let verifier: RuntimeClient | undefined;
  let verifierHealthy = false;
  try {
    await shutdownRuntimeAndWait(adminRuntime);
    adminRuntime.dispose();
    writePointer(pointer, { root: targetRoot, previousRoot: priorPointer?.root, activatedAt: new Date().toISOString() });
    verifier = new RuntimeClient();
    await verifier.request('runtime.health', {});
    verifierHealthy = true;
    const status = await verifier.request('data.status', {});
    if (canonicalPath(status.root) !== targetRoot) throw new Error('The restarted runtime is serving a different data root');
    adminRuntime = verifier;
    attachAdminRuntime(adminRuntime);
    verifier = undefined;
  } catch (error) {
    if (verifier) {
      if (verifierHealthy) {
        try { await shutdownRuntimeAndWait(verifier); } catch { /* preserve the original verification error */ }
      }
      verifier.dispose();
    }
    restorePointer(pointer, priorPointer);
    adminRuntime = createAdminRuntime();
    try {
      const restored = await adminRuntime.request('data.status', {});
      if (canonicalPath(restored.root) !== sourceRoot) throw new Error('Rollback restarted a runtime with the wrong data root');
    } catch (rollbackError) {
      adminRuntime.dispose();
      throw new Error(`Data relocation failed and rollback could not restore the source runtime: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
  requestApplicationRestart();
  return { activated: true };
}

async function shutdownRuntimeAndWait(client: RuntimeClient): Promise<void> {
  await client.request('runtime.shutdown', { operationId: randomUUID() });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (!await runtimePipeIsOpen()) return;
    await delay(100);
  }
  throw new Error('The runtime acknowledged shutdown but did not release its pipe');
}

function readPointer(path: string): { root: string; previousRoot?: string; activatedAt?: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).root === 'string') return value as { root: string; previousRoot?: string; activatedAt?: string };
  } catch { /* no active pointer */ }
  return undefined;
}
function writePointer(path: string, value: { root: string; previousRoot?: string; activatedAt?: string }): void {
  writeFileSync(`${path}.next`, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  renameSync(`${path}.next`, path);
}
function restorePointer(path: string, previous: { root: string; previousRoot?: string; activatedAt?: string } | undefined): void {
  if (previous) writePointer(path, previous);
  else { try { unlinkSync(path); } catch { /* pointer did not exist */ } }
}
function canonicalPath(value: string): string { return canonicalRelocationPath(value, realpathSync, process.platform); }

function requestApplicationRestart(): void {
  if (process.env.THREADTERM_V3_RELOCATION_QA === '1' && !app.isPackaged) {
    (globalThis as typeof globalThis & { relocationQaRestart?: { relaunch: number; exit: number } }).relocationQaRestart = { relaunch: 1, exit: 1 };
    return;
  }
  app.relaunch();
  app.exit(0);
}

function isPreparedRelocation(value: unknown): value is { sourceRoot: string; targetRoot: string; activationToken: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).sourceRoot === 'string' && typeof (value as Record<string, unknown>).targetRoot === 'string' && typeof (value as Record<string, unknown>).activationToken === 'string';
}

async function windowAction(event: IpcMainInvokeEvent, action: unknown): Promise<void> {
  if (action !== 'minimize' && action !== 'maximize' && action !== 'close' && action !== 'quit') throw new Error('Unsupported window action');
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Window is no longer available');
  if (action === 'minimize') window.minimize();
  else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
  else if (action === 'close') window.close();
  else await requestQuit();
}

async function requestQuit(): Promise<void> {
  if (allowQuit || quitPending) return;
  quitPending = true;
  // Tray quit must never attach its confirmation to an invisible owner.
  try {
    showMainWindow();
    const runtimeRunning = await runtimePipeIsOpen();
    let active = runtimeRunning;
    let zh = false;
    const confirm = async () => {
      const options = quitConfirmationOptions(zh, nativeImage.createFromDataURL(applicationIconPng));
      const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
      return result.response === 1;
    };
    if (runtimeRunning) {
      const inspectionClient = new RuntimeClient({ autoLaunch: false });
      try {
        const snapshot = await inspectionClient.request('runtime.snapshot', {});
        zh = notificationLocale(snapshot.settings) === 'zh-CN';
        active = snapshot.sessions.some(session => ['starting', 'running', 'idle', 'waiting'].includes(session.status));
      }
      catch { /* Unknown state still requires confirmation; keep the English fallback. */ }
      finally { inspectionClient.dispose(); }
    }
    const confirmed = active && (quitConfirmationPreapproved(process.env) || await confirm());
    if (active && !confirmed) return;
    stoppingRuntime = true;
    // Stop every ordinary client's reconnect/auto-launch before asking the
    // daemon to exit. A dedicated no-launch client owns the final handshake.
    const ordinaryClients = [adminRuntime, ...windowRuntimes.values()];
    for (const client of ordinaryClients) client.setSuspended(true);
    const shutdownClient = new RuntimeClient({ autoLaunch: false });
    try {
      // A daemon spawned before suspension may not have bound its pipe yet.
      // Wait only existing attempts, then re-probe; never launch for shutdown.
      const settleDeadline = Date.now() + 30_000;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(ordinaryClients.map(client => client.whenConnectionAttemptSettled())),
          new Promise<never>((_, reject) => { settleTimer = setTimeout(() => reject(new Error('Runtime startup did not settle before shutdown')), 30_000); }),
        ]);
      } finally { if (settleTimer) clearTimeout(settleTimer); }
      await waitForPendingRuntimeStartup(Math.max(1, settleDeadline - Date.now()));
      const runtimeReady = await runtimePipeIsOpen();
      if (runtimeReady && !confirmed) {
        let lateActive = true;
        try {
          const snapshot = await shutdownClient.request('runtime.snapshot', {});
          zh = notificationLocale(snapshot.settings) === 'zh-CN';
          lateActive = snapshot.sessions.some(session => ['starting', 'running', 'idle', 'waiting'].includes(session.status));
        } catch { /* Unknown late state requires confirmation as well. */ }
        if (lateActive && !await confirm()) {
          stoppingRuntime = false;
          for (const client of ordinaryClients) client.setSuspended(false);
          return;
        }
      }
      if (runtimeReady) {
        try { await shutdownClient.request('runtime.shutdown', { operationId: randomUUID() }); }
        finally { shutdownClient.dispose(); }
        const deadline = Date.now() + 12_000;
        while (await runtimePipeIsOpen()) {
          if (Date.now() >= deadline) throw new Error('The runtime acknowledged shutdown but did not release its pipe');
          await delay(100);
        }
      }
    } catch (error) {
      stoppingRuntime = false;
      adminRuntime.setSuspended(false);
      for (const client of windowRuntimes.values()) client.setSuspended(false);
      const options = {
        type: 'error',
        noLink: true,
        icon: nativeImage.createFromDataURL(applicationIconPng),
        title: zh ? 'ThreadTerm 未能停止运行时' : 'ThreadTerm could not stop the runtime',
        message: error instanceof Error ? error.message : zh ? '运行时未确认关闭。' : 'The runtime did not confirm shutdown.',
        detail: zh ? '应用将保持打开，保留正在运行的工作。' : 'The application remains open to preserve running work.',
      } satisfies Electron.MessageBoxOptions;
      if (mainWindow) await dialog.showMessageBox(mainWindow, options); else await dialog.showMessageBox(options);
      return;
    } finally { shutdownClient.dispose(); }
    allowQuit = true;
    for (const id of [...outputSubscriptions.keys()]) closeOutputSubscription(id);
    adminRuntime.dispose();
    for (const client of windowRuntimes.values()) client.dispose();
    windowRuntimes.clear();
    app.quit();
  } finally { quitPending = false; }
}

function closeOutputSubscription(id: string): void { const subscription = outputSubscriptions.get(id); if (subscription) { for (const acknowledge of subscription.acknowledgements.splice(0)) acknowledge(); subscription.unsubscribe?.(); } outputSubscriptions.delete(id); }
function runtimeFor(event: IpcMainInvokeEvent): RuntimeClient {
  if (stoppingRuntime) throw new Error('ThreadTerm is shutting down');
  const key = event.sender.id;
  let client = windowRuntimes.get(key);
  if (!client) {
    client = new RuntimeClient();
    windowRuntimes.set(key, client);
    client.onEvent((value: RuntimeEvent) => { if (!event.sender.isDestroyed()) event.sender.send('threadterm:event', value); });
    event.sender.once('destroyed', () => {
      client?.dispose();
      windowRuntimes.delete(key);
      for (const [id, subscription] of outputSubscriptions) if (subscription.ownerId === key) closeOutputSubscription(id);
    });
  }
  return client;
}
function isWindowOptions(value: unknown): value is { sessionId?: string; workspaceId?: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (typeof (value as Record<string, unknown>).sessionId === 'undefined' || typeof (value as Record<string, unknown>).sessionId === 'string')
    && (typeof (value as Record<string, unknown>).workspaceId === 'undefined' || typeof (value as Record<string, unknown>).workspaceId === 'string');
}
function isRevealSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function isRevealPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 16 * 1024
    && !value.includes('\0')
    && !isAbsolute(value);
}
function isMissingPath(error: unknown): boolean {
  return !!error && typeof error === 'object' && ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));
}
function canonicalExistingParent(scope: string, path: string): string {
  let candidate = dirname(path);
  while (isWithinScope(scope, candidate)) {
    try {
      const canonical = realpathSync(candidate);
      if (!statSync(canonical).isDirectory() || !isWithinScope(scope, canonical)) throw new Error('File is outside its project scope');
      return canonical;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const next = dirname(candidate);
      if (next === candidate) break;
      candidate = next;
    }
  }
  throw new Error('File parent directory is unavailable');
}
