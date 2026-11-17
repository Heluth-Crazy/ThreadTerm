import { app, BrowserWindow, ipcMain, nativeImage, screen, type IpcMainEvent, type NativeImage } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Settings } from '@threadterm/protocol';
import type { IslandModel } from '../../renderer/src/island/model.js';
import type { MachineTreeStore, WatchNotice } from './machineWatcher.js';
import { fullscreenState, IslandTracker, islandHandlesToasts, islandKey, islandPreferences, islandSources, islandVisible, pendingApproval, resultLine,
  taskbarBadge, type IslandItem, type IslandPreferences, type TaskbarBadge } from './taskIslandModel.js';

/* The task island (owner design 2026-11-16, prototypes/task-island): a transparent, always-on-top, non-focusable
   window at the top centre of the screen that shows running and waiting sessions while ThreadTerm is in the
   background. Clicks pass through everywhere but the island itself. */

export const ISLAND_WIDTH = 440;
export const ISLAND_HEIGHT = 380;
const SNAP = 28;
const POLL_MS = 2500;
/** While the island catches clicks, how often main checks that the pointer is still over its window. */
const POINTER_WATCH_MS = 100;

export interface TaskIslandHost {
  tree: MachineTreeStore;
  mainWindow(): BrowserWindow | undefined;
  /** A ThreadTerm window other than the island has focus and is on screen. */
  appFocused(): boolean;
  openSession(machineId: string, sessionId: string): void;
  openApp(): void;
  /** This PC's `system.notificationState`; rejects on a runtime that predates it. */
  notificationState(): Promise<{ state: string }>;
  load(window: BrowserWindow): Promise<void>;
  preload: string;
  configPath: string;
}

export class TaskIsland {
  private readonly tracker = new IslandTracker();
  private preferences: IslandPreferences = islandPreferences(undefined);
  private lightweight = false;
  private zh = false;
  private window?: BrowserWindow;
  private ready = false;
  private shown = false;
  private fullscreen = false;
  private offset = 0;
  private dragBase?: number;
  private pollTimer?: ReturnType<typeof setInterval>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private pointerTimer?: ReturnType<typeof setInterval>;
  private badge: TaskbarBadge;
  private model?: IslandModel;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: TaskIslandHost) {
    try {
      const saved = JSON.parse(readFileSync(host.configPath, 'utf8')) as { offset?: unknown };
      if (typeof saved.offset === 'number' && Number.isFinite(saved.offset)) this.offset = saved.offset;
    } catch { /* first run or unreadable: centred */ }
  }

  start(): void {
    this.cleanup.push(this.host.tree.observe(() => this.sync()));
    const refresh = () => this.publish();
    app.on('browser-window-focus', refresh); app.on('browser-window-blur', refresh);
    this.cleanup.push(() => { app.off('browser-window-focus', refresh); app.off('browser-window-blur', refresh); });
    const place = () => this.place();
    screen.on('display-metrics-changed', place); screen.on('display-added', place); screen.on('display-removed', place);
    this.cleanup.push(() => { screen.off('display-metrics-changed', place); screen.off('display-added', place); screen.off('display-removed', place); });
    const own = (event: IpcMainEvent) => !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
    const on = (channel: string, listener: (event: IpcMainEvent, value: unknown) => void) => {
      const guarded = (event: IpcMainEvent, value: unknown) => { if (own(event)) listener(event, value); };
      ipcMain.on(channel, guarded); this.cleanup.push(() => ipcMain.off(channel, guarded));
    };
    on('task-island:ready', () => { this.ready = true; this.send(); });
    on('task-island:interactive', (_event, value) => this.interactive(value === true));
    on('task-island:open', (_event, key) => {
      const item = this.model?.items.find(row => row.key === key);
      if (item) this.host.openSession(item.machineId, item.sessionId);
    });
    on('task-island:open-app', () => this.host.openApp());
    on('task-island:drag', (_event, value) => this.drag(value));
    this.sync();
  }

  dispose(): void {
    for (const undo of this.cleanup.splice(0)) undo();
    this.stopPolling(); this.stopPointerWatch(); clearTimeout(this.expiryTimer); clearTimeout(this.hideTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  /** Whether session toasts should stay quiet because the island carries them. */
  handlesToasts(): boolean { return islandHandlesToasts(this.preferences, this.lightweight); }

  /** A reply or failure from an agent the island showed working. */
  notice(source: WatchNotice): void {
    const { event } = source, data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    if (typeof data.sessionId !== 'string') return;
    const key = islandKey(source.machine.id, data.sessionId);
    let state: 'done' | 'error' | undefined;
    if (event.event === 'inbox.created') state = data.kind === 'reply' ? 'done' : data.kind === 'error' ? 'error' : undefined;
    else if (event.event === 'session.status' && this.tracker.mode(key) === 'terminal' && ['exited', 'error', 'interrupted'].includes(String(data.status))) {
      state = data.status === 'exited' && (data.exitCode === undefined || data.exitCode === 0) ? 'done' : 'error';
    }
    if (!state || !this.tracker.finish(key, state, Date.now(), this.preferences.alert ? 5200 : 4000)) return;
    this.scheduleExpiry();
    this.publish();
    if (this.tracker.mode(key) === 'chat') void this.read(key, data.sessionId, 32_768).then(items => {
      if (items && this.tracker.setResult(key, resultLine(items, state))) this.publish();
    });
  }

  private sync(): void {
    const settings = this.host.tree.state('local')?.settings as Settings | undefined;
    this.preferences = islandPreferences(settings?.notifications);
    this.lightweight = settings?.lightweightMode === true;
    this.zh = settings?.language === 'zh-CN' || (settings?.language === undefined && app.getLocale().toLowerCase().startsWith('zh'));
    const sources = this.host.tree.entries().flatMap(entry => islandSources(entry.tree, entry.sessions, entry.providers));
    const fresh = this.tracker.update(sources, Date.now());
    for (const key of fresh) {
      const item = sources.find(source => source.key === key);
      if (item?.mode === 'chat') void this.read(key, item.sessionId, 65_536).then(items => {
        if (!items || !this.tracker.setApproval(key, pendingApproval(items))) return;
        // An `input` wait needs the user only once its request is read: that is when it may flash the taskbar.
        if (item.state === 'input' && this.tracker.needsUser(key)) this.flash();
        this.publish();
      });
    }
    if (fresh.some(key => this.tracker.needsUser(key))) this.flash();
    this.publish();
  }

  private flash(): void {
    if (this.preferences.badge && !this.host.appFocused()) this.host.mainWindow()?.flashFrame(true);
  }

  /**
   * The page reports the pointer over the island (catch clicks) or over the transparent rest (let them through). While
   * clicks are caught, main decides when the pointer has left the window: the moment Windows stops forwarding, it
   * delivers a stale "mouse left" to the page, so the page cannot tell that from a real exit and would let the click
   * through again (owner report 2026-11-16: the island could not be clicked).
   */
  private interactive(on: boolean): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(!on, { forward: true });
    if (!on) { this.stopPointerWatch(); return; }
    if (this.pointerTimer) return;
    this.pointerTimer = setInterval(() => {
      const current = this.window;
      const point = screen.getCursorScreenPoint(), bounds = current && !current.isDestroyed() && current.isVisible() ? current.getBounds() : undefined;
      if (bounds && point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height) return;
      this.stopPointerWatch();
      if (current && !current.isDestroyed()) { current.setIgnoreMouseEvents(true, { forward: true }); current.webContents.send('task-island:pointer-left'); }
    }, POINTER_WATCH_MS);
  }
  private stopPointerWatch(): void { clearInterval(this.pointerTimer); this.pointerTimer = undefined; }

  private async read(key: string, sessionId: string, maxBytes: number) {
    const machineId = key.slice(0, key.indexOf('\u0000'));
    const entry = this.host.tree.entries().find(row => row.tree.machine.id === machineId);
    try { return entry ? (await entry.request('chat.snapshot', { sessionId, maxBytes })).items : undefined; } catch { return undefined; }
  }

  private publish(): void {
    const items = this.tracker.items();
    const focused = this.host.appFocused();
    this.updateBadge(items, focused);
    const enabled = this.preferences.enabled && !this.lightweight;
    if (!enabled) { this.stopPolling(); this.fullscreen = false; this.destroyWindow(); this.model = undefined; return; }
    // Asking Windows about full-screen apps only matters while the island would otherwise be up.
    if (!focused && items.length) this.startPolling(); else { this.stopPolling(); this.fullscreen = false; }
    const visible = islandVisible({ preferences: this.preferences, lightweight: this.lightweight, appFocused: focused, fullscreen: this.fullscreen, items: items.length });
    const providers = new Map<string, { id: string; name: string; icon?: string }>();
    for (const entry of this.host.tree.entries()) for (const provider of entry.providers) {
      if (!items.some(item => item.provider === provider.id) || providers.has(provider.id)) continue;
      providers.set(provider.id, { id: provider.id, name: provider.name, icon: typeof provider.icon === 'string' && provider.icon.startsWith('data:image/') ? provider.icon : undefined });
    }
    this.model = { visible, zh: this.zh, alert: this.preferences.alert, items, providers: [...providers.values()] };
    if (visible) {
      clearTimeout(this.hideTimer); this.hideTimer = undefined;
      const window = this.window && !this.window.isDestroyed() ? this.window : this.create();
      if (!this.shown) { this.place(window); window.showInactive(); window.moveTop(); this.shown = true; }
    } else if (this.shown && !this.hideTimer) {
      // The page fades the island out (and an emptied island plays its dismiss motion) before the window goes.
      this.hideTimer = setTimeout(() => {
        this.hideTimer = undefined;
        if (this.model?.visible) return;
        this.stopPointerWatch(); this.window?.hide(); this.window?.setIgnoreMouseEvents(true, { forward: true }); this.shown = false;
      }, items.length ? 450 : 1200);
    }
    this.send();
  }

  private send(): void {
    if (this.ready && this.model && this.window && !this.window.isDestroyed()) this.window.webContents.send('task-island:model', this.model);
  }

  private create(): BrowserWindow {
    const window = new BrowserWindow({
      width: ISLAND_WIDTH, height: ISLAND_HEIGHT, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false,
      alwaysOnTop: true, title: 'ThreadTerm',
      webPreferences: { preload: this.host.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.once('closed', () => { if (this.window === window) { this.window = undefined; this.ready = false; this.shown = false; } });
    this.window = window; this.ready = false; this.shown = false;
    this.place(window);
    void this.host.load(window).catch(() => undefined);
    return window;
  }

  private destroyWindow(): void {
    clearTimeout(this.hideTimer); this.hideTimer = undefined; this.stopPointerWatch();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined; this.ready = false; this.shown = false;
  }

  /** Top centre of the screen that holds ThreadTerm's main window, moved sideways by the saved drag offset. */
  private place(window = this.window): void {
    if (!window || window.isDestroyed()) return;
    const owner = this.host.mainWindow();
    const area = (owner && !owner.isDestroyed() ? screen.getDisplayMatching(owner.getBounds()) : screen.getPrimaryDisplay()).workArea;
    const half = Math.max(0, (area.width - ISLAND_WIDTH) / 2);
    const offset = Math.max(-half, Math.min(half, this.offset));
    window.setBounds({ x: Math.round(area.x + area.width / 2 - ISLAND_WIDTH / 2 + offset), y: area.y, width: ISLAND_WIDTH, height: ISLAND_HEIGHT });
  }

  private drag(value: unknown): void {
    const data = value && typeof value === 'object' ? value as { phase?: unknown; dx?: unknown } : {};
    const dx = typeof data.dx === 'number' && Number.isFinite(data.dx) ? data.dx : 0;
    if (data.phase === 'start') { this.dragBase = this.offset; return; }
    if (this.dragBase === undefined) return;
    const next = this.dragBase + dx;
    this.offset = Math.abs(next) < SNAP ? 0 : next;
    this.place();
    if (data.phase !== 'end') return;
    this.dragBase = undefined;
    try {
      writeFileSync(`${this.host.configPath}.tmp`, JSON.stringify({ offset: Math.round(this.offset) }));
      renameSync(`${this.host.configPath}.tmp`, this.host.configPath);
    } catch { /* the position is a convenience */ }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const poll = () => void this.host.notificationState().then(result => fullscreenState(result.state), () => false).then(fullscreen => {
      if (fullscreen === this.fullscreen || !this.pollTimer) return;
      this.fullscreen = fullscreen; this.publish();
    });
    this.pollTimer = setInterval(poll, POLL_MS);
    poll();
  }
  private stopPolling(): void { clearInterval(this.pollTimer); this.pollTimer = undefined; }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    const next = this.tracker.nextExpiry();
    if (next === undefined) return;
    this.expiryTimer = setTimeout(() => { if (this.tracker.expire(Date.now())) this.publish(); this.scheduleExpiry(); }, Math.max(0, next - Date.now()) + 20);
  }

  /** The taskbar button: a green dot while agents run, orange while one needs you; it stops flashing once ThreadTerm is in front. */
  private updateBadge(items: IslandItem[], focused: boolean): void {
    const owner = this.host.mainWindow();
    if (!owner || owner.isDestroyed()) return;
    if (focused) owner.flashFrame(false);
    const badge = this.preferences.badge ? taskbarBadge(items) : undefined;
    if (badge === this.badge) return;
    this.badge = badge;
    if (!badge) { owner.setOverlayIcon(null, ''); owner.flashFrame(false); return; }
    owner.setOverlayIcon(overlay(badge), badge === 'needs' ? (this.zh ? '有任务需要你处理' : 'A task needs you') : (this.zh ? '有任务在运行' : 'Tasks are running'));
  }
}

const overlays = new Map<string, NativeImage>();
/** A 16 px status dot drawn at 2x: green, or orange with an exclamation mark, ringed so it reads on any icon. */
function overlay(badge: 'needs' | 'running'): NativeImage {
  const cached = overlays.get(badge);
  if (cached) return cached;
  const size = 32, centre = size / 2, radius = size / 2 - 0.5, ring = 3;
  const fill = badge === 'needs' ? [0xff, 0x9f, 0x0a] : [0x30, 0xd1, 0x58], edge = [0x1c, 0x1c, 0x1e], mark = [0x24, 0x15, 0x00];
  const pixels = Buffer.alloc(size * size * 4);
  const cover = (distance: number) => Math.max(0, Math.min(1, distance + 0.5));
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const px = x + 0.5, py = y + 0.5, distance = Math.hypot(px - centre, py - centre);
    const alpha = cover(radius - distance);
    if (!alpha) continue;
    let colour = cover(radius - ring - distance) > 0.5 ? fill : edge;
    if (badge === 'needs' && colour === fill) {
      const bar = Math.abs(px - centre) <= 2 && py >= centre - 8 && py <= centre + 2;
      const dot = Math.hypot(px - centre, py - (centre + 6)) <= 2.2;
      if (bar || dot) colour = mark;
    }
    const offset = (y * size + x) * 4; // BGRA, premultiplied
    pixels[offset] = Math.round(colour[2]! * alpha); pixels[offset + 1] = Math.round(colour[1]! * alpha);
    pixels[offset + 2] = Math.round(colour[0]! * alpha); pixels[offset + 3] = Math.round(255 * alpha);
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  overlays.set(badge, image);
  return image;
}
