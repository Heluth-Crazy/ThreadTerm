import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, globalShortcut, Notification, screen, session, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { readFileSync, renameSync, writeFileSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { validateRequest, type Method, type RequestParams, type RuntimeEvent } from '@threadterm/protocol';
import { RuntimeClient, runtimePipeIsOpen } from './runtime-client.js';
import { floatIdentity, nextFloatKey, tiledFloatBounds, type FloatMode } from './floatingWindows.js';
import { notificationPreferences, shouldShowNativeNotification, type NotificationKind } from './notificationPreferences.js';
import { inboxNotificationCopy, type InboxNotice } from './inboxNotification.js';
import { ignoreBrokenStdio, isBrokenPipeError } from './stdioGuards.js';
import { resolveWindowChrome } from './windowChrome.js';
import { terminalWindowArguments } from './terminalEnvironment.js';

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
let lastSessionId: string | undefined;
let lastNotificationSeq = 0;
let lightweightMode = false;
let floatMode: FloatMode = 'manual';
const floatingWindows = new Map<string, BrowserWindow>();
let activeFloatKey: string | undefined;
const windowChrome = resolveWindowChrome(process.platform, release(), process.env.THREADTERM_V3_WINDOW_CHROME);

app.setName('ThreadTerm');
// Test-only isolated Electron profile. Production launchers never set this.
if (process.env.THREADTERM_V3_USER_DATA) app.setPath('userData', process.env.THREADTERM_V3_USER_DATA);
app.on('window-all-closed', () => undefined);
app.on('before-quit', (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
app.on('will-quit', () => { adminRuntime.dispose(); for (const client of windowRuntimes.values()) client.dispose(); });

void app.whenReady().then(async () => {
  registerIpc();
  await runScheduledElectronCacheCleanup();
  void refreshDesktopPreferences();
  mainWindow = createWindow();
  createTray();
});

function createAdminRuntime(): RuntimeClient {
  const client = new RuntimeClient();
  attachAdminRuntime(client);
  return client;
}
function attachAdminRuntime(client: RuntimeClient): void {
  client.onEvent((event) => {
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
function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url)) throw new Error('Untrusted renderer IPC sender');
}
function trayImage(): Electron.NativeImage {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cornerX = x < 7 ? 7 - x : x > 24 ? x - 24 : 0;
      const cornerY = y < 7 ? 7 - y : y > 24 ? y - 24 : 0;
      if (cornerX * cornerX + cornerY * cornerY > 49) continue;
      const bar = (y >= 9 && y < 13 && x >= 7 && x < 25)
        || (y >= 16 && y < 19 && x >= 9 && x < 23)
        || (y >= 21 && y < 24 && x >= 9 && x < 18);
      const offset = (y * size + x) * 4;
      pixels[offset] = bar ? 0xeb : 0x27;
      pixels[offset + 1] = bar ? 0xe7 : 0x18;
      pixels[offset + 2] = bar ? 0xe5 : 0x11;
      pixels[offset + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function createWindow(options: { sessionId?: string; workspaceId?: string; floating?: boolean; background?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: options.floating ? 900 : 1440,
    height: options.floating ? 640 : 920,
    minWidth: options.floating ? 520 : 960,
    minHeight: options.floating ? 400 : 640,
    show: false,
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
      webSecurity: true,
      additionalArguments: terminalWindowArguments(process.platform, release()),
    },
  });
  const emitWindowState = () => { if (!window.isDestroyed()) window.webContents.send('threadterm:window-state', { maximized: window.isMaximized() }); };
  window.on('maximize', emitWindowState);
  window.on('unmaximize', emitWindowState);
  window.once('ready-to-show', () => { if (options.background) window.showInactive(); else window.show(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
function completionMessage(value: { status: string }): string { return value.status === 'exited' ? 'A terminal session finished.' : value.status === 'error' ? 'A terminal session failed.' : 'A terminal session was interrupted.'; }
async function notifyTerminalCompletion(event: RuntimeEvent): Promise<void> {
  const completion = event.data;
  if (!isTerminalCompletion(completion) || event.seq <= lastNotificationSeq) return;
  try {
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    if (snapshot.sessions.find((session) => session.id === completion.sessionId)?.mode !== 'terminal') return;
    if (event.seq <= lastNotificationSeq) return;
    lastNotificationSeq = event.seq;
    const kind: NotificationKind = completion.status === 'exited' ? 'completed' : 'attention';
    void notifyNative(kind, kind === 'completed' ? 'ThreadTerm session completed' : 'ThreadTerm needs attention', completionMessage(completion));
  } catch { /* A later inbox event remains the authoritative chat notification. */ }
}
function stateChangeKind(value: unknown): string | undefined { return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).kind === 'string' ? (value as Record<string, unknown>).kind as string : undefined; }
function isInboxNotification(value: unknown): value is InboxNotice { const kind = stateChangeKind(value); return kind === 'approval' || kind === 'reply' || kind === 'error' || kind === 'waiting'; }
function inboxNoticeFromEvent(value: InboxNotice): InboxNotice {
  return { kind: value.kind, sessionId: value.sessionId, title: value.title, provider: value.provider };
}
function inboxNotificationKind(value: InboxNotice): NotificationKind { return value.kind === 'reply' ? 'completed' : 'attention'; }
async function presentInboxNotification(value: InboxNotice): Promise<void> {
  let notice = inboxNoticeFromEvent(value);
  try {
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    const session = notice.sessionId ? snapshot.sessions.find((item) => item.id === notice.sessionId) : undefined;
    if (session) notice = { ...notice, title: notice.title || session.title, provider: notice.provider || session.provider };
  } catch { /* Kind-only payload is still enough to notify. */ }
  const copy = inboxNotificationCopy(notice);
  void notifyNative(inboxNotificationKind(notice), copy.title, copy.body);
}
async function notifyNative(kind: NotificationKind, title: string, body: string): Promise<{ sent: boolean; reason?: string }> {
  if (!Notification.isSupported()) return { sent: false, reason: 'Native notifications are unsupported on this system' };
  try {
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    if (!shouldShowNativeNotification(snapshot.settings.notifications, kind)) return { sent: false, reason: 'Native notifications are disabled in settings' };
    const preferences = notificationPreferences(snapshot.settings.notifications);
    new Notification({ title, body, silent: !preferences.sound }).show();
    return { sent: true };
  } catch { return { sent: false, reason: 'Native notification preferences are unavailable' }; }
}

function registerIpc(): void {
  ipcMain.handle('threadterm:request', async (event, method: unknown, params: unknown) => {
    assertTrustedRenderer(event);
    validateRequest(method, params);
    return runtimeFor(event).request(method, params as RequestParams<Method>);
  });
  ipcMain.handle('threadterm:subscribe-output', async (event, sessionId: unknown, cursor: unknown, id: unknown) => {
    assertTrustedRenderer(event);
    if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(cursor) || Number(cursor) < 0 || typeof id !== 'string' || !id) throw new Error('Invalid output subscription');
    const outputCursor = Number(cursor);
    outputSubscriptions.set(id, { ownerId: event.sender.id, acknowledgements: [] });
    const unsubscribe = await runtimeFor(event).subscribeOutput(sessionId, outputCursor, (chunk) => new Promise<void>((resolvePromise) => {
      if (event.sender.isDestroyed()) { resolvePromise(); return; }
      const subscription = outputSubscriptions.get(id);
      if (!subscription) { resolvePromise(); return; }
      subscription.acknowledgements.push(resolvePromise);
      event.sender.send('threadterm:output', { id, chunk });
    }));
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
  ipcMain.handle('threadterm:activate-data-relocation', async (event, prepared: unknown) => { assertTrustedRenderer(event); return activateDataRelocation(prepared); });
  ipcMain.handle('threadterm:choose-save-path', async (event, kind: unknown) => {
    assertTrustedRenderer(event);
    if (kind !== 'database' && kind !== 'settings' && kind !== 'theme') throw new Error('Unsupported save kind');
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: kind === 'database' ? 'Back up ThreadTerm data' : 'Save ThreadTerm settings',
      defaultPath: kind === 'database' ? 'threadterm-v3-backup.sqlite3' : `threadterm-v3-${kind}.json`,
      filters: kind === 'database' ? [{ name: 'SQLite database', extensions: ['sqlite3'] }] : [{ name: 'JSON', extensions: ['json'] }],
    } satisfies Electron.SaveDialogOptions;
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    return result.canceled ? null : (result.filePath ?? null);
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
  ipcMain.handle('threadterm:export-diagnostics', async (event) => { assertTrustedRenderer(event); const owner=BrowserWindow.fromWebContents(event.sender); const saved=owner?await dialog.showSaveDialog(owner,{defaultPath:'threadterm-v3-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]}):await dialog.showSaveDialog({defaultPath:'threadterm-v3-diagnostics.json'}); if(saved.canceled||!saved.filePath)return null; const snapshot=await adminRuntime.request('runtime.snapshot',{}); const health=await adminRuntime.request('runtime.health',{}); const report={version:app.getVersion(),platform:process.platform,runtime:health,counts:{projects:snapshot.projects.length,sessions:snapshot.sessions.length,providers:snapshot.providers.length},providers:snapshot.providers.map(p=>({id:p.id,installed:p.installed,version:p.version,terminal:p.terminal,chat:p.chat}))}; writeFileSync(saved.filePath,JSON.stringify(report,null,2)); return saved.filePath; });
  ipcMain.handle('threadterm:test-notification', async (event) => { assertTrustedRenderer(event); return notifyNative('attention', 'ThreadTerm', 'Native notifications are enabled.'); });
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
function canonicalPath(value: string): string { return realpathSync(value).toLowerCase(); }

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
  if (allowQuit) return;
  const active = await hasActiveSessions();
  if (active) {
    const options = {
      type: 'warning',
      buttons: ['Keep ThreadTerm running', 'Quit application'],
      defaultId: 0,
      cancelId: 0,
      title: 'Sessions are still running',
      message: 'Quitting will stop all running sessions and the ThreadTerm runtime.',
      detail: 'Keep ThreadTerm running to leave this work untouched in the background.',
    } satisfies Electron.MessageBoxOptions;
    const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    if (result.response !== 1) return;
  }
  try {
    await adminRuntime.request('runtime.shutdown', { operationId: randomUUID() });
  } catch (error) {
    const options = {
      type: 'error',
      title: 'ThreadTerm could not stop the runtime',
      message: error instanceof Error ? error.message : 'The runtime did not confirm shutdown.',
      detail: 'The application remains open so running work is not abandoned without confirmation.',
    } satisfies Electron.MessageBoxOptions;
    if (mainWindow) await dialog.showMessageBox(mainWindow, options); else await dialog.showMessageBox(options);
    return;
  }
  allowQuit = true;
  for (const subscription of outputSubscriptions.values()) subscription.unsubscribe?.();
  outputSubscriptions.clear();
  app.quit();
}

async function hasActiveSessions(): Promise<boolean> {
  try {
    const snapshot = await adminRuntime.request('runtime.snapshot', {});
    return snapshot.sessions.some((session) => ['starting', 'running', 'waiting'].includes(session.status));
  } catch { return false; }
}

function closeOutputSubscription(id: string): void { const subscription = outputSubscriptions.get(id); if (subscription) { for (const acknowledge of subscription.acknowledgements.splice(0)) acknowledge(); subscription.unsubscribe?.(); } outputSubscriptions.delete(id); }
function runtimeFor(event: IpcMainInvokeEvent): RuntimeClient {
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
