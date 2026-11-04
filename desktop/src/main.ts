import { app, BrowserWindow, WebContentsView, View, Menu, Tray, dialog, ipcMain, nativeImage, safeStorage, shell, globalShortcut, Notification, screen, session, protocol, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { canonicalRelocationPath } from './relocationPaths.js';
import { readFileSync, renameSync, writeFileSync, unlinkSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { validateRequest, type Method, type RequestParams, type RuntimeEvent, type Settings } from '@threadterm/protocol';
import { RuntimeClient, RuntimeRequestError, runtimePipeIsOpen, waitForPendingRuntimeStartup } from './runtime-client.js';
import { floatIdentity, nextFloatKey, tiledFloatBounds, type FloatMode } from './floatingWindows.js';
import { nativeDelivery, type NotificationKind } from './notificationPreferences.js';
import { machineNotificationFocused, machineNotificationCopy, inboxNotificationCopy, notificationLocale, terminalNotificationCopy, terminalNotificationKind, testNotificationCopy, type InboxNotice, type NotificationLocale } from './inboxNotification.js';
import { ignoreBrokenStdio, isBrokenPipeError } from './stdioGuards.js';
import { resolveWindowChrome } from './windowChrome.js';
import { terminalWindowArguments } from './terminalEnvironment.js';
import { registerPageComments } from './pageComments.js';
import { registerBrowser, clearBrowserPartition } from './browser/index.js';
import { MachineBrowserProfiles, machineBrowserPartition } from './machineBrowser.js';
import { externalLinkOpensInPanel } from './loopbackProxy.js';
import { nativeMarkdownExportFiles, saveChatMarkdown, writeChatMarkdownAtomic } from './chatMarkdownExport.js';
import { applicationIconPng, trayIconPng } from '../assets/icon-data.js';
import { quitConfirmationOptions, quitConfirmationPreapproved } from './quitConfirmation.js';
import { deletedRevealScope, isWithinScope, revealTarget } from './revealFile.js';
import { qaAttachPathsOverride, readAttachFiles, uploadAttachFile, validAttachPath, MAX_ATTACH_FILES } from './attachFiles.js';
import { readHostPageShot, reviewShotSession } from './remoteFiles.js';
import { HostFilePickers, hostRevealTarget } from './hostFiles.js';
import { localPageShotPath } from './pageComments.js';
import { qaOpenExternalPathsOverride } from './externalFiles.js';

import { HtmlPreviewGrantManager, HTML_PREVIEW_PRIVILEGED_SCHEME, mergePreviewIsolationFeatures, installHtmlPreviewSession, attachHtmlPreviewWindow } from './htmlPreview.js';
import { registerHtmlPreviewIpc } from './htmlPreviewIpc.js';
import { BACKGROUND_IMAGE_PRIVILEGED_SCHEME, backgroundImagesFolder, installBackgroundImageSession, registerBackgroundImageIpc } from './backgroundImages.js';
import { buildThemeExport, importThemePackImages, qaThemeExportOverride } from './themePackCore.js';
import { appCspForHtml, buildAppCsp } from './appCsp.js';
import { MachineTreeStore, type WatchNotice } from './machineWatcher.js';
import { MachineRegistry } from './machines.js';
import { MachineBindings, MachineViews } from './machineViews.js';
import { createAppSessionPreparer } from './appSession.js';
import { certificateCheckCode, connectPinned, pairOnPinnedConnection, parsePairDescriptor, type PairDescriptor } from './peer-transport.js';
import type { MachineInfo, MachineSnapshot } from '../../renderer/src/machineTypes.js';
import type { TLSSocket } from 'node:tls';

// One call for every privileged scheme: Electron keeps only the last registerSchemesAsPrivileged call.
protocol.registerSchemesAsPrivileged([HTML_PREVIEW_PRIVILEGED_SCHEME, BACKGROUND_IMAGE_PRIVILEGED_SCHEME]);
app.commandLine.appendSwitch('enable-features', mergePreviewIsolationFeatures(app.commandLine.getSwitchValue('enable-features')));
const htmlPreviewGrants = new HtmlPreviewGrantManager();
let htmlPreviewPreloadReady = false;
const prepareAppSession = createAppSessionPreparer((appSession: Electron.Session) => {
  installAppCspHeader(appSession);
  installHtmlPreviewSession(appSession, htmlPreviewGrants, { appFrameAncestor: process.env.THREADTERM_V3_DEV_SERVER_URL ? new URL(process.env.THREADTERM_V3_DEV_SERVER_URL).origin : 'file:' });
  installBackgroundImageSession(appSession, backgroundImagesFolder());
  try {
    const preloadPath = join(__dirname, 'htmlPreviewSandboxPreload.cjs');
    if (!statSync(preloadPath).isFile()) return false;
    appSession.registerPreloadScript({ type: 'frame', filePath: preloadPath });
    return true;
  } catch { return false; }
});
const machineBindings = new MachineBindings<BrowserWindow>();
const machineRenderers = new Map<number, Electron.WebContents>();
const machineViews = new Map<number, MachineViews<View>>();
const machineStates = new Map<string, Pick<MachineInfo, 'state' | 'message'>>();
const pendingPairings = new Map<number, { descriptor: PairDescriptor; socket: TLSSocket; timer: NodeJS.Timeout }>();
let machines: MachineRegistry;
let remoteMachinesEnabled = false;
let machineBrowsers: MachineBrowserProfiles | undefined;

ignoreBrokenStdio();
process.on('uncaughtException', (error) => {
  if (isBrokenPipeError(error)) return;
  try {
    dialog.showErrorBox('A JavaScript error occurred in the main process', error instanceof Error ? (error.stack ?? error.message) : String(error));
  } catch { /* stdout may already be gone */ }
});

const machineTree = new MachineTreeStore(feed => {
  for (const contents of machineRenderers.values()) if (!contents.isDestroyed()) contents.send('threadterm:machine-tree', feed);
}, notice => { void notifyMachineEvent(notice); }, 250, () => remoteMachinesEnabled);
const pendingMachineSession = new Map<string, string>();
let adminRuntime = createAdminRuntime();
const windowRuntimes = new Map<number, RuntimeClient>();
const outputSubscriptions = new Map<string, { ownerId: number; unsubscribe?: () => void; acknowledgements: Array<() => void> }>();
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let allowQuit = false;
let quitPending = false;
let stoppingRuntime = false;
let lastSessionId: string | undefined;
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
app.on('will-quit', () => { machineBrowsers?.close(); machineTree.stop(); adminRuntime.dispose(); for (const client of windowRuntimes.values()) client.dispose(); });

void app.whenReady().then(async () => {
  htmlPreviewPreloadReady = prepareAppSession(session.defaultSession);
  machines = new MachineRegistry(join(app.getPath('userData'), 'machines.json'), safeStorage);
  machineTree.add(machines.list()[0], adminRuntime, false);
  registerIpc();
  // The window and its launch screen come up at once and cover the runtime start. A scheduled cache cleanup needs
  // the runtime's settings, so it runs alongside instead of keeping the window back until the runtime answers.
  mainWindow = createWindow();
  createTray();
  void refreshDesktopPreferences();
  await runScheduledElectronCacheCleanup();
});

function createAdminRuntime(): RuntimeClient {
  const client = new RuntimeClient({ controlOnly: true });
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
  });
  if (machines) machineTree.add(machines.list()[0], client, false);
}
function syncMachineWatchers(): void {
  if (!machines) return;
  const entries = machines.list().filter(item => item.id === 'local' || remoteMachinesEnabled);
  machineTree.retain(new Set(entries.map(item => item.id)));
  for (const machine of entries) if (!machineTree.has(machine.id)) {
    machineTree.add(machine, machine.id === 'local' ? adminRuntime : new RuntimeClient({ controlOnly: true,
      profile: { ...machines.profile(machine.id), desktopVersion: app.getVersion() } }), machine.id !== 'local');
  }
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
  machineBindings.get(event.sender.id);
}
function trayImage(): Electron.NativeImage {
  return nativeImage.createFromDataURL(trayIconPng);
}
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function createWindow(options: { sessionId?: string; workspaceId?: string; floating?: boolean; background?: boolean; machineId?: string } = {}): BrowserWindow {
  const machineId = options.machineId ?? 'local';
  const partition = machineId === 'local' ? undefined : `persist:machine-${machineId}`;
  prepareAppSession(partition ? session.fromPartition(partition) : session.defaultSession);
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
      ...(partition ? { partition } : {}),
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      webSecurity: true,
      additionalArguments: [...terminalWindowArguments(process.platform, release()), `--threadterm-machine-id=${machineId}`],
    },
  });
  bindMachineRenderer(window.webContents, machineId, window);
  if (!options.floating) {
    const localView = window.contentView;
    const root = new View();
    window.setContentView(root);
    root.addChildView(localView);
    const views = new MachineViews<View>(localView, id => {
      const appSession = session.fromPartition(`persist:machine-${id}`);
      prepareAppSession(appSession);
      const view = new WebContentsView({ webPreferences: { session: appSession, preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, additionalArguments: [...terminalWindowArguments(process.platform, release()), `--threadterm-machine-id=${id}`] } });
      bindMachineRenderer(view.webContents, id, window);
      view.webContents.on('will-navigate', (event, url) => { if (!isTrustedRendererUrl(url)) event.preventDefault(); });
      root.addChildView(view);
      void loadRenderer(view.webContents, { machineId: id, sessionId: pendingMachineSession.get(id) });
      return view;
    }, () => window.getContentSize() as [number, number]);
    machineViews.set(window.id, views);
    views.show('local');
    window.on('resize', () => views.resize());
    window.once('closed', () => {
      machineViews.delete(window.id);
      for (const view of views.all()) if (view instanceof WebContentsView && !view.webContents.isDestroyed()) view.webContents.close();
    });
  }
  if (machineId !== 'local') window.setTitle(`ThreadTerm — ${machines.list().find(item => item.id === machineId)?.name ?? 'Computer'}`);
  // The taskbar group has a separate icon source from WM_GETICON. Bind it to
  // this packaged executable instead of relying on a matching old shortcut.
  if (process.platform === 'win32' && app.isPackaged) {
    window.setAppDetails({ appId: 'com.threadterm.v3', appIconPath: process.execPath, appIconIndex: 0 });
  }
  const emitWindowState = () => {
    if (window.isDestroyed()) return;
    const state = { maximized: window.isMaximized() };
    window.webContents.send('threadterm:window-state', state);
    for (const view of machineViews.get(window.id)?.all() ?? []) if (view instanceof WebContentsView && view.webContents !== window.webContents && !view.webContents.isDestroyed()) view.webContents.send('threadterm:window-state', state);
  };
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
  void loadRenderer(window.webContents, options);
  return window;
}

async function loadRenderer(window: Electron.WebContents, options: { sessionId?: string; workspaceId?: string; floating?: boolean; machineId?: string }): Promise<void> {
  const query = new URLSearchParams();
  if (options.machineId && options.machineId !== 'local') query.set('machineView', '1');
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
  const enabled = !!(settings.remoteMachines as { enabled?: boolean } | undefined)?.enabled;
  applyMachinesGate(enabled);
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
async function notifyMachineEvent(source: WatchNotice): Promise<void> {
  if (stoppingRuntime) return;
  if (source.event.event === 'session.status') await notifyTerminalCompletion(source.event, source);
  else if (source.event.event === 'inbox.created' && isInboxNotification(source.event.data)) await presentInboxNotification(source.event.data, source);
}
async function notifyTerminalCompletion(event: RuntimeEvent, source: WatchNotice): Promise<void> {
  const completion = event.data;
  if (!isTerminalCompletion(completion)) return;
  const session = source.state.sessions.find(item => item.id === completion.sessionId);
  if (session?.mode !== 'terminal') return;
  const exitCode = (completion as { exitCode?: unknown }).exitCode;
  const notice = { status: completion.status, exitCode: typeof exitCode === 'number' ? exitCode : session.exitCode, title: session.title, provider: session.provider, providerName: source.state.providers.find(provider => provider.id === session.provider)?.name };
  await notifyNative(terminalNotificationKind(notice), locale => terminalNotificationCopy(notice, locale), machineNoticeOptions(source, completion.sessionId));
}
function stateChangeKind(value: unknown): string | undefined { return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).kind === 'string' ? (value as Record<string, unknown>).kind as string : undefined; }
function isInboxNotification(value: unknown): value is InboxNotice { const kind = stateChangeKind(value); return kind === 'approval' || kind === 'reply' || kind === 'error' || kind === 'waiting'; }
function inboxNoticeFromEvent(value: InboxNotice): InboxNotice {
  return { kind: value.kind, sessionId: value.sessionId, title: value.title, provider: value.provider, providerName: value.providerName };
}
function inboxNotificationKind(value: InboxNotice): NotificationKind { return value.kind === 'reply' ? 'completed' : 'attention'; }
async function presentInboxNotification(value: InboxNotice, source: WatchNotice): Promise<void> {
  let notice = inboxNoticeFromEvent(value);
  const session = source.state.sessions.find(item => item.id === notice.sessionId);
  if (session) notice = { ...notice, title: notice.title || session.title, provider: notice.provider || session.provider, providerName: source.state.providers.find(provider => provider.id === session.provider)?.name };
  await notifyNative(inboxNotificationKind(notice), locale => inboxNotificationCopy(notice, locale), machineNoticeOptions(source, notice.sessionId));
}
/** This PC's notifications keep their plain copy; another computer's carry its name. The toast is shown on this PC,
 * so delivery and language always follow this PC's settings. */
function machineNoticeOptions(source: WatchNotice, sessionId: string | undefined): { sessionId?: string; machineId: string; machineName?: string; settings?: Settings } {
  return source.machine.id === 'local'
    ? { sessionId, machineId: 'local', settings: source.state.settings }
    : { sessionId, machineId: source.machine.id, machineName: source.machine.name, settings: machineTree.state('local')?.settings };
}
/** Recent notifications stay referenced, so a click (also later from the Action Center) still reaches its handler. */
const recentNotifications: Notification[] = [];
/** Shows an OS notification for a session event or a Settings test, as nativeDelivery decides, in the app language.
 * A click brings ThreadTerm forward on the session. Never throws: session events arrive via the admin runtime's
 * event handler. Resolves once Windows has shown the toast (or reported it failed). */
async function notifyNative(kind: NotificationKind, copy: (locale: NotificationLocale) => { title: string; body: string }, options: { sessionId?: string; machineId?: string; machineName?: string; settings?: Settings; test?: boolean } = {}): Promise<{ sent: boolean; reason?: string }> {
  let locale: NotificationLocale = 'en';
  try {
    const settings = options.settings ?? (await adminRuntime.request('runtime.snapshot', {})).settings;
    locale = notificationLocale(settings);
    const zh = locale === 'zh-CN';
    if (!Notification.isSupported()) return { sent: false, reason: zh ? '此系统不支持系统通知。' : 'This system does not support native notifications.' };
    // A minimized or tray-hidden window can still report focus on Windows; neither is the user looking at ThreadTerm.
    const focused = BrowserWindow.getFocusedWindow();
    const viewedMachineId = focused ? machineViews.get(focused.id)?.currentId
      ?? (machineRenderers.has(focused.webContents.id) ? machineBindings.get(focused.webContents.id).machineId : 'local') : undefined;
    const delivery = nativeDelivery(settings.notifications, kind, { appFocused: machineNotificationFocused(options.machineId, viewedMachineId, !!focused && focused.isVisible() && !focused.isMinimized()), test: options.test });
    if (!delivery.deliver) return { sent: false, reason: delivery.reason === 'disabled' ? (zh ? '请先开启“允许系统通知”。' : 'Turn on "Allow system notifications" first.') : delivery.reason };
    const text = options.machineName ? machineNotificationCopy(options.machineName, copy(locale)) : copy(locale);
    const notification = new Notification({ ...text, silent: delivery.silent });
    recentNotifications.push(notification);
    if (recentNotifications.length > 20) recentNotifications.shift();
    notification.on('click', () => {
      const remote = options.machineId !== undefined && options.machineId !== 'local';
      if (remote) {
        // A removed computer, or one hidden by the gate, cannot be reopened by an old notification.
        if (remoteMachinesEnabled && machines.list().some(item => item.id === options.machineId)) showMachine(mainWindow, options.machineId!, options.sessionId);
        else showMainWindow();
      } else if (options.sessionId && remoteMachinesEnabled) showMachine(mainWindow, 'local', options.sessionId);
      else if (options.sessionId) routeMainWindow({ sessionId: options.sessionId });
      else showMainWindow();
    });
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
  const hostFilePickers = new HostFilePickers();
  ipcMain.handle('threadterm:host-files-complete', (event, id: unknown, paths: unknown) => {
    assertTrustedRenderer(event);
    if (machineBindings.get(event.sender.id).machineId === 'local') throw new Error('Host file dialog requires another computer');
    hostFilePickers.complete(event.sender.id, id, paths);
  });
  ipcMain.handle('threadterm:machine-list', async event => {
    assertTrustedRenderer(event);
    await refreshMachinesGate();
    return machineSnapshot(event.sender.id);
  });
  ipcMain.handle('threadterm:machine-show', async (event, id: unknown, sessionId: unknown) => {
    assertTrustedRenderer(event);
    await assertMachinesEnabled();
    if (typeof id !== 'string' || !machines.list().some(item => item.id === id)) throw new Error('Unknown computer');
    if (sessionId !== undefined && !isRevealSessionId(sessionId)) throw new Error('Invalid session');
    const bound = machineBindings.get(event.sender.id);
    const owner = machineViews.has(bound.owner.id) ? bound.owner : mainWindow;
    showMachine(owner, id, sessionId as string | undefined);
  });
  ipcMain.handle('threadterm:machine-settings', async event => {
    assertTrustedRenderer(event); await assertMachinesEnabled();
    const bound = machineBindings.get(event.sender.id);
    const owner = machineViews.has(bound.owner.id) ? bound.owner : mainWindow;
    showMachine(owner, 'local');
    (owner ?? mainWindow)?.webContents.send('threadterm:desktop-navigate', { action: 'computers' });
  });
  ipcMain.handle('threadterm:machine-tree-get', event => { assertTrustedRenderer(event); return machineTree.feed(); });
  ipcMain.handle('threadterm:machine-expand', (event, key: unknown, expanded: unknown) => {
    assertTrustedRenderer(event);
    if (typeof key !== 'string' || key.length > 32768 || typeof expanded !== 'boolean') throw new Error('Invalid tree expansion');
    let tuple: unknown; try { tuple = JSON.parse(key); } catch { throw new Error('Invalid tree key'); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some(part => typeof part !== 'string') || !machines.list().some(item => item.id === tuple[0])) throw new Error('Unknown tree key');
    machineTree.expand(key, expanded);
  });
  ipcMain.handle('threadterm:machine-prepare', async (event, text: unknown) => {
    assertTrustedRenderer(event); assertLocalMachine(event); await assertMachinesEnabled();
    machines.assertEncryptionAvailable();
    if (typeof text !== 'string') throw new Error('Paste a ThreadTerm pairing offer');
    cancelPendingPairing(event.sender.id);
    const descriptor = parsePairDescriptor(text);
    const socket = await connectPinned(descriptor.serverUrl, descriptor.tlsFingerprint, 'http/1.1');
    if (event.sender.isDestroyed() || !remoteMachinesEnabled) { socket.destroy(); throw new Error('Pairing cancelled'); }
    cancelPendingPairing(event.sender.id);
    const timer = setTimeout(() => cancelPendingPairing(event.sender.id), 60000);
    pendingPairings.set(event.sender.id, { descriptor, socket, timer });
    return { checkCode: certificateCheckCode(descriptor.tlsFingerprint), endpoint: descriptor.serverUrl };
  });
  ipcMain.handle('threadterm:machine-add', async (event, options: unknown) => {
    assertTrustedRenderer(event); assertLocalMachine(event); await assertMachinesEnabled(); machines.assertEncryptionAvailable();
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Choose a computer name and color');
    const { name, color } = options as { name?: unknown; color?: unknown };
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Choose a computer name and color');
    const pending = pendingPairings.get(event.sender.id);
    if (!pending) throw new Error('Check the pairing offer before adding a computer');
    pendingPairings.delete(event.sender.id); clearTimeout(pending.timer);
    const credential = await pairOnPinnedConnection(pending.socket, pending.descriptor, name.trim());
    if (!remoteMachinesEnabled || event.sender.isDestroyed()) throw new Error('Pairing cancelled');
    const entry = machines.add({ name, color, endpoint: pending.descriptor.serverUrl, pin: pending.descriptor.tlsFingerprint }, credential);
    syncMachineWatchers(); broadcastMachines();
    return entry;
  });
  ipcMain.handle('threadterm:machine-remove', async (event, id: unknown) => {
    assertTrustedRenderer(event); assertLocalMachine(event); await assertMachinesEnabled();
    if (typeof id !== 'string' || id === 'local' || !machines.list().some(item => item.id === id)) throw new Error('Unknown computer');
    for (const [key, client] of windowRuntimes) if (machineBindings.get(key).machineId === id) { client.dispose(); windowRuntimes.delete(key); }
    for (const [windowId, views] of machineViews) {
      const removed = views.remove(id);
      if (removed) {
        const owner = BrowserWindow.fromId(windowId);
        owner?.contentView.removeChildView(removed);
        if (removed instanceof WebContentsView && !removed.webContents.isDestroyed()) removed.webContents.close();
        if (views.currentId === 'local') owner?.setTitle('ThreadTerm');
      }
    }
    for (const window of BrowserWindow.getAllWindows()) if (machineBindings.get(window.webContents.id).machineId === id) window.destroy();
    machineBrowsers?.release(machineBrowserPartition(id));await clearBrowserPartition(machineBrowserPartition(id));
    machines.remove(id); machineTree.remove(id); machineStates.delete(id); broadcastMachines();
  });
  machineBrowsers = new MachineBrowserProfiles();
  registerBrowser(event => {
    assertTrustedRenderer(event);
    const { owner, machineId } = machineBindings.get(event.sender.id);
    if (machineId !== 'local' && !remoteMachinesEnabled) throw new Error('Remote computers are disabled');
    if (!owner || machineRenderers.get(event.sender.id) !== event.sender || event.senderFrame !== event.sender.mainFrame) throw new Error('Browser commands require the application main frame');
  },event=>{
    const runtime=runtimeFor(event);
    return {browserRequest:(method,params)=>runtime.browserRequest(method,params),onBrowserFrame:listener=>runtime.onBrowserFrame(listener),onBrowserDisconnect:listener=>runtime.onBrowserDisconnect(listener),onEvent:listener=>runtime.onEvent(listener),snapshot:()=>runtime.request('runtime.snapshot',{})};
  }, contents => {
    if (!machineRenderers.has(contents.id)) return undefined;
    const bound = machineBindings.get(contents.id);
    const views=machineViews.get(bound.owner.id)?.all();
    return views?.find(view=>view instanceof WebContentsView&&view.webContents===contents) ?? (bound.machineId==='local'?views?.[0]??bound.owner.contentView:undefined);
  }, {
    partitionFor: contents => machineBrowserPartition(machineBindings.get(contents.id).machineId),
    windowFor: contents => machineBindings.get(contents.id).owner,
    prepare: async event => { const {machineId}=machineBindings.get(event.sender.id);if(machineId!=='local')await machineBrowsers!.prepare(machineId,machines.list().find(machine=>machine.id===machineId)?.name??'Computer',event.sender,runtimeFor(event)); },
    released: partition => machineBrowsers?.release(partition),
  });
  registerHtmlPreviewIpc(htmlPreviewGrants, assertTrustedRenderer, runtimeFor, () => htmlPreviewPreloadReady, event => machineBindings.get(event.sender.id).machineId !== 'local');
  registerBackgroundImageIpc({ folder: backgroundImagesFolder(), assertTrusted: assertTrustedRenderer, isPackaged: app.isPackaged });
  registerPageComments(assertTrustedRenderer, async after => {
    const references = await adminRuntime.request('reviewDrafts.assetReferences', after ? { after, limit: 200 } : { limit: 200 });
    return { paths: references.paths, nextAfter: references.nextAfter, legacyImportComplete: references.legacyImportComplete };
  }, async (event, id) => machineBindings.get(event.sender.id).machineId !== 'local' ? readHostPageShot(runtimeFor(event), id) : undefined, sender => {
    if (!machineRenderers.has(sender.id)) return undefined;
    const binding = machineBindings.get(sender.id); return binding.machineId !== 'local' ? binding.owner : undefined;
  });
  ipcMain.handle('threadterm:upload-client-files', async (event, sessionId: unknown, paths: unknown) => {
    assertTrustedRenderer(event);
    if (machineBindings.get(event.sender.id).machineId === 'local') throw new Error('Remote upload requires another computer');
    if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(paths) || paths.length > MAX_ATTACH_FILES || !paths.every(validAttachPath)) throw new Error('Invalid attachment upload');
    const result: string[] = [];
    for (const path of paths) result.push((await uploadAttachFile(runtimeFor(event), sessionId, path)).hostPath);
    return result;
  });
  ipcMain.handle('threadterm:read-attach-paths', async (event, paths: unknown) => {
    assertTrustedRenderer(event);
    if (machineBindings.get(event.sender.id).machineId === 'local' || !Array.isArray(paths) || paths.length > MAX_ATTACH_FILES || !paths.every(validAttachPath)) throw new Error('Invalid attachment paths');
    return readAttachFiles(paths);
  });
  ipcMain.handle('threadterm:persist-page-shot', async (event, id: unknown, sessionId: unknown, projectId: unknown, root: unknown) => {
    assertTrustedRenderer(event);
    if (machineBindings.get(event.sender.id).machineId === 'local' || typeof id !== 'string') throw new Error('Invalid remote screenshot');
    const runtime = runtimeFor(event);
    try { const existing = await runtime.request('attachment.read', { assetId: id, offset: 0, limit: 1 }); return { id: existing.assetId, path: existing.hostPath }; }
    catch (error) { if (!(error instanceof RuntimeRequestError) || !/asset_not_found/.test(error.message)) throw error; }
    const path = await localPageShotPath(id);
    if (!path) throw new Error('Screenshot is unavailable');
    if (sessionId === undefined) {
      const snapshot = await runtime.request('runtime.snapshot', {});
      sessionId = reviewShotSession(snapshot, projectId, root);
    }
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Screenshot destination session is unavailable');
    const uploaded = await uploadAttachFile(runtime, sessionId, path);
    return { id: uploaded.assetId, path: uploaded.hostPath };
  });
  ipcMain.handle('threadterm:export-chat-markdown', (event, payload: unknown) => saveChatMarkdown(event, payload, {
    assertTrusted: assertTrustedRenderer,
    choosePath: async options => { const owner = machineBindings.get(event.sender.id).owner; return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options); },
    write: writeChatMarkdownAtomic,
    files: nativeMarkdownExportFiles,
    alive: () => !event.sender.isDestroyed(),
  }));
  ipcMain.handle('threadterm:request', async (event, method: unknown, params: unknown) => {
    assertTrustedRenderer(event);
    validateRequest(method, params);
    // Narrowing a connection's events is for main's watchers; a renderer doing it would silently lose its Chat stream.
    if (method === 'runtime.events.filter') throw new Error('runtime.events.filter is not available to windows');
    const runtime = runtimeFor(event);
    if (method === 'data.backup') await event.sender.session.flushStorageData();
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
    if (machineBindings.get(event.sender.id).machineId !== 'local') return (await hostFilePickers.choose(event.sender, 'directory'))[0] ?? null;
    assertLocalMachine(event);
    const owner = machineBindings.get(event.sender.id).owner;
    const options = { properties: ['openDirectory', 'createDirectory'] as Electron.OpenDialogOptions['properties'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('threadterm:attach-files', async (event) => {
    assertTrustedRenderer(event);
    // QA can point the picker at fixture paths so the real app never opens a native dialog.
    const qaPaths = qaAttachPathsOverride(process.env.THREADTERM_V3_ATTACH_FILES_QA, app.isPackaged);
    if (qaPaths) return readAttachFiles(qaPaths);
    const owner = machineBindings.get(event.sender.id).owner;
    const options = { title: 'Attach files', properties: ['openFile', 'multiSelections'] as Electron.OpenDialogOptions['properties'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : readAttachFiles(result.filePaths);
  });
  ipcMain.handle('threadterm:open-external-files', async (event) => {
    assertTrustedRenderer(event);
    if (machineBindings.get(event.sender.id).machineId !== 'local') return hostFilePickers.choose(event.sender, 'files');
    assertLocalMachine(event);
    const qaPaths = qaOpenExternalPathsOverride(process.env.THREADTERM_V3_OPEN_EXTERNAL_QA, app.isPackaged);
    if (qaPaths) return qaPaths;
    const owner = machineBindings.get(event.sender.id).owner;
    const options = { title: 'Open file outside workspace', properties: ['openFile', 'multiSelections'] as Electron.OpenDialogOptions['properties'] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('threadterm:activate-data-relocation', async (event, prepared: unknown) => { assertTrustedRenderer(event); assertLocalMachine(event); return activateDataRelocation(prepared); });
  ipcMain.handle('threadterm:choose-save-path', async (event, kind: unknown) => {
    assertTrustedRenderer(event);
    if (kind !== 'database' && kind !== 'settings' && kind !== 'theme') throw new Error('Unsupported save kind');
    const owner = machineBindings.get(event.sender.id).owner;
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
    const content = kind === 'settings' ? await runtimeFor(event).request('settings.export', {}) : (await runtimeFor(event).request('runtime.snapshot', {})).settings.customThemes;
    if (kind === 'theme' && (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).length === 0)) throw new Error('There are no custom themes to export');
    // A theme that carries background images exports them inside the pack; a palette-only export stays plain JSON.
    const exported = kind === 'theme' && machineBindings.get(event.sender.id).machineId === 'local' ? await buildThemeExport(backgroundImagesFolder(), content) : undefined;
    if (exported?.missing.length) console.warn(`Theme export skipped ${exported.missing.length} background image(s) missing from the store`);
    const owner = machineBindings.get(event.sender.id).owner;
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
  ipcMain.handle('threadterm:window-state', (event) => { assertTrustedRenderer(event); return { maximized: machineBindings.get(event.sender.id).owner?.isMaximized() ?? false }; });
  ipcMain.handle('threadterm:open-window', async (_event, options: unknown) => {
    assertTrustedRenderer(_event);
    if (!isWindowOptions(options)) throw new Error('Invalid window options');
    openFloatingWindow({ ...options, machineId: machineBindings.get(_event.sender.id).machineId });
  });
  ipcMain.handle('threadterm:desktop-preferences', async (event) => { assertTrustedRenderer(event); return refreshDesktopPreferences(); });
  ipcMain.handle('threadterm:open-directory', async (event, projectId: unknown, worktreeId: unknown) => {
    assertTrustedRenderer(event);
    if (machineBindings.get(event.sender.id).machineId !== 'local') {
      if (typeof projectId !== 'string' || !projectId) throw new Error('Invalid project');
      const runtime = runtimeFor(event), snapshot = await runtime.request('runtime.snapshot', {});
      let path = snapshot.projects.find(project => project.id === projectId)?.path;
      if (worktreeId !== undefined) {
        if (typeof worktreeId !== 'string' || !worktreeId) throw new Error('Invalid worktree');
        const tree = (await runtime.request('worktree.list', { projectId })).find(tree => tree.id === worktreeId && tree.projectId === projectId && !tree.missing);
        path = tree?.path;
      }
      if (!path) throw new Error('Project directory is unavailable');
      event.sender.send('threadterm:host-files', { id: randomUUID(), mode: 'reveal', path }); return;
    }
    assertLocalMachine(event);
    if (typeof projectId !== 'string' || !projectId) throw new Error('Invalid project');
    const data = await runtimeFor(event).request('runtime.snapshot', {});
    const project = data.projects.find(item => item.id === projectId);
    if (!project) throw new Error('Project directory is unavailable');
    let directory = project.path;
    if (worktreeId !== undefined) {
      if (typeof worktreeId !== 'string' || !worktreeId) throw new Error('Invalid worktree');
      const trees = await runtimeFor(event).request('worktree.list', { projectId });
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
    if (machineBindings.get(event.sender.id).machineId !== 'local') {
      if (!isRevealSessionId(sessionId) || !isRevealPath(path)) throw new Error('Invalid file reveal request');
      const target = await hostRevealTarget(runtimeFor(event), sessionId, path);
      event.sender.send('threadterm:host-files', { id: randomUUID(), mode: 'reveal', ...target }); return;
    }
    assertLocalMachine(event);
    if (!isRevealSessionId(sessionId) || !isRevealPath(path)) throw new Error('Invalid file reveal request');
    let target: { scope: string; path: string };
    try {
      const resolved = await runtimeFor(event).request('filesystem.resolve', { sessionId, path });
      if (!resolved.worktreePath) throw new Error('File project scope is unavailable');
      target = revealTarget(resolved, realpathSync(resolved.worktreePath));
    } catch (error) {
      if (!(error instanceof RuntimeRequestError) || error.code !== 'file_reference_not_found') throw error;
      const scope = deletedRevealScope(await runtimeFor(event).request('runtime.snapshot', {}), sessionId);
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
    if (machineBindings.get(event.sender.id).machineId !== 'local') {
      const { directory } = await runtimeFor(event).request('plugin.list', {});
      event.sender.send('threadterm:host-files', { id: randomUUID(), mode: 'reveal', path: directory }); return;
    }
    assertLocalMachine(event);
    const { directory } = await runtimeFor(event).request('plugin.list', {});
    mkdirSync(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  ipcMain.handle('threadterm:export-diagnostics', async (event) => { assertTrustedRenderer(event); const owner=machineBindings.get(event.sender.id).owner; const saved=owner?await dialog.showSaveDialog(owner,{defaultPath:'threadterm-v3-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]}):await dialog.showSaveDialog({defaultPath:'threadterm-v3-diagnostics.json'}); if(saved.canceled||!saved.filePath)return null; const snapshot=await runtimeFor(event).request('runtime.snapshot',{}); const health=await runtimeFor(event).request('runtime.health',{}); const report={version:app.getVersion(),platform:process.platform,runtime:health,counts:{projects:snapshot.projects.length,sessions:snapshot.sessions.length,providers:snapshot.providers.length},providers:snapshot.providers.map(p=>({id:p.id,installed:p.installed,version:p.version,terminal:p.terminal,chat:p.chat}))}; writeFileSync(saved.filePath,JSON.stringify(report,null,2)); return saved.filePath; });
  ipcMain.handle('threadterm:test-notification', async (event) => { assertTrustedRenderer(event); return notifyNative('attention', testNotificationCopy, { test: true }); });
  ipcMain.handle('threadterm:schedule-electron-cache-cleanup', async (event, schedule: unknown) => {
    assertTrustedRenderer(event);
    assertLocalMachine(event);
    if (typeof schedule !== 'boolean') throw new Error('Invalid cleanup schedule');
    if (process.platform !== 'win32') return { scheduled: false, available: false, result: 'Cache cleanup is available on Windows only.' };
    const snapshot = await runtimeFor(event).request('runtime.snapshot', {});
    await runtimeFor(event).request('settings.update', { patch: { electronCacheCleanup: schedule ? { state: 'scheduled', scheduledAt: new Date().toISOString() } : null }, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
    return { scheduled: schedule, available: true };
  });
  ipcMain.handle('threadterm:open-external', async (_event, url: unknown) => {
    assertTrustedRenderer(_event);
    if (typeof url !== 'string') throw new Error('Invalid external URL');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only HTTP(S) external URLs are allowed');
    if (externalLinkOpensInPanel(parsed.toString(), machineBindings.get(_event.sender.id).machineId !== 'local')) {
      _event.sender.send('threadterm:browser-event', { type: 'open', url: parsed.toString() }); return;
    }
    await shell.openExternal(parsed.toString());
  });
}

function openFloatingWindow(options: { sessionId?: string; workspaceId?: string; background?: boolean; machineId?: string }): void {
  if (lightweightMode && (!options.machineId || options.machineId === 'local')) { routeMainWindow(options); return; }
  const identity = floatIdentity(options);
  const key = identity ? `${options.machineId ?? 'local'}:${identity}` : undefined;
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
      const appSessions = [session.defaultSession, ...machines.list().filter(machine => machine.id !== 'local').map(machine => session.fromPartition(`persist:machine-${machine.id}`))];
      for (const appSession of appSessions) await appSession.clearCache();
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
    verifier = new RuntimeClient({ controlOnly: true });
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
  const window = machineBindings.get(event.sender.id).owner;
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
function bindMachineRenderer(contents: Electron.WebContents, machineId: string, owner: BrowserWindow): void {
  machineBindings.bind(contents.id, machineId, owner);
  machineRenderers.set(contents.id, contents);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('page-title-updated', event => {
    event.preventDefault();
    if (owner.isDestroyed()) return;
    const current = machineViews.get(owner.id)?.currentId ?? machineId;
    owner.setTitle(current === 'local' ? 'ThreadTerm' : `ThreadTerm — ${machines.list().find(item => item.id === current)?.name ?? 'Computer'}`);
  });
  contents.once('destroyed', () => {
    cancelPendingPairing(contents.id);
    machineBindings.remove(contents.id);
    machineRenderers.delete(contents.id);
  });
}
function cancelPendingPairing(senderId: number): void {
  const pending = pendingPairings.get(senderId);
  if (pending) { clearTimeout(pending.timer); pending.socket.destroy(); pendingPairings.delete(senderId); }
}
function assertLocalMachine(event: IpcMainInvokeEvent): void {
  if (machineBindings.get(event.sender.id).machineId !== 'local') throw new Error('This action is only available on This PC');
}
async function assertMachinesEnabled(): Promise<void> {
  await refreshMachinesGate();
  if (!remoteMachinesEnabled) throw new Error('Enable the Computers preview on This PC first');
}
async function refreshMachinesGate(): Promise<void> {
  const { settings } = await adminRuntime.request('runtime.snapshot', {});
  applyMachinesGate(!!(settings.remoteMachines as { enabled?: boolean } | undefined)?.enabled);
}
function applyMachinesGate(enabled: boolean): void {
  if (enabled === remoteMachinesEnabled) return;
  remoteMachinesEnabled = enabled;
  syncMachineWatchers();
  if (enabled) machineTree.republish();
  if (!enabled) {
    machineBrowsers?.close();
    for (const [id, client] of windowRuntimes) if (machineBindings.get(id).machineId !== 'local') { client.dispose(); windowRuntimes.delete(id); }
    for (const [windowId, views] of machineViews) {
      const owner = BrowserWindow.fromId(windowId);
      views.show('local'); owner?.setTitle('ThreadTerm');
      for (const machine of machines.list()) if (machine.id !== 'local') {
        const removed = views.remove(machine.id);
        if (removed) {
          owner?.contentView.removeChildView(removed);
          if (removed instanceof WebContentsView && !removed.webContents.isDestroyed()) removed.webContents.close();
        }
      }
    }
    for (const window of BrowserWindow.getAllWindows()) if (machineBindings.get(window.webContents.id).machineId !== 'local') window.destroy();
    for (const id of pendingPairings.keys()) cancelPendingPairing(id);
    machineStates.clear();
  }
  broadcastMachines();
}
function showMachine(owner: BrowserWindow | undefined, id: string, sessionId?: string): void {
  if (!owner || owner.isDestroyed()) { showMainWindow(); owner = mainWindow; }
  if (!owner || !machineViews.has(owner.id)) return;
  if (sessionId) pendingMachineSession.set(id, sessionId);
  const view = machineViews.get(owner.id)!.show(id);
  pendingMachineSession.delete(id);
  const contents = view instanceof WebContentsView ? view.webContents : owner.webContents;
  if (sessionId) {
    const route = () => { if (!contents.isDestroyed()) contents.send('threadterm:desktop-navigate', { sessionId }); };
    if (contents.isLoading()) contents.once('did-finish-load', route); else route();
  }
  owner.setTitle(id === 'local' ? 'ThreadTerm' : `ThreadTerm — ${machines.list().find(item => item.id === id)?.name ?? 'Computer'}`);
  contents.focus(); owner.show(); owner.focus(); broadcastMachines();
}
function machineSnapshot(senderId: number): MachineSnapshot {
  const watched = new Map(machineTree.feed().machines.map(row => [row.machine.id, row.machine]));
  return { enabled: remoteMachinesEnabled, currentId: machineBindings.get(senderId).machineId,
    machines: remoteMachinesEnabled ? machines.list().map(item => ({ ...item, ...machineStates.get(item.id), ...watched.get(item.id) })) : [] };
}
function broadcastMachines(): void {
  for (const contents of machineRenderers.values()) if (!contents.isDestroyed()) contents.send('threadterm:machines-changed');
}
function runtimeFor(event: IpcMainInvokeEvent): RuntimeClient {
  if (stoppingRuntime) throw new Error('ThreadTerm is shutting down');
  const key = event.sender.id;
  const { machineId } = machineBindings.get(key);
  if (machineId !== 'local' && !remoteMachinesEnabled) throw new Error('Remote computers are disabled on This PC');
  let client = windowRuntimes.get(key);
  if (!client) {
    client = new RuntimeClient(machineId === 'local' ? {} : { profile: { ...machines.profile(machineId), desktopVersion: app.getVersion() } });
    if (machineId !== 'local') { machineStates.set(machineId, { state: 'connecting' }); broadcastMachines(); }
    windowRuntimes.set(key, client);
    client.onEvent((value: RuntimeEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('threadterm:event', value);
      if (machineId !== 'local' && value.event === 'runtime.transport' && value.data && typeof value.data === 'object') {
        const data = value.data as { state?: string; message?: string; reason?: string };
        const state = data.state === 'reconnected' ? 'connected' : data.state === 'incompatible' ? 'incompatible' : data.state === 'pin-mismatch' ? 'pin-mismatch' : 'disconnected';
        if(state!=='connected')machineBrowsers?.disconnect(machineId);
        machineStates.set(machineId, { state, message: data.message ?? data.reason }); broadcastMachines();
      }
    });
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
