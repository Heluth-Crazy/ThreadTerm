import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PagePick, PageRect, PageShot } from '@threadterm/protocol';
import { MAX_PAGE_SHOT_BYTES, pageCaptureRect, pageImageSize, pageRect, pageShotPath, sanitizePagePick, sanitizePageTargetRef, validPageFrameName, validPageShotId } from './pageCommentsCore.js';
import { pagePickerSource } from './pagePickerScript.js';

type PendingPick = { frame: WebFrameMain; cancel: () => void; cancelled: boolean };
const pendingPicks = new Map<string, PendingPick>();

function findFrame(sender: WebContents, name: unknown): WebFrameMain | undefined {
  if (!validPageFrameName(name)) throw new Error('Invalid preview frame name');
  if (sender.isDestroyed()) return undefined;
  return sender.mainFrame.framesInSubtree.find((frame) => frame.parent && !frame.detached && frame.name === name);
}

async function shotDirectory(create = false): Promise<string> {
  const userData = await realpath(app.getPath('userData'));
  const directory = join(userData, 'page-comments');
  if (create) await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  if (resolve(actual) !== resolve(directory)) throw new Error('Page shot directory escaped user data');
  return actual;
}

function missingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function confinedShot(directory: string, id: string, extension: 'png' | 'jpg'): Promise<string | undefined> {
  const path = pageShotPath(directory, id, extension);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid page shot file');
    const actual = await realpath(path);
    if (dirname(actual) !== directory || actual !== path) throw new Error('Page shot path escaped its directory');
    return path;
  } catch (error) { if (missingFile(error)) return undefined; throw error; }
}

export async function readPageShot(id: unknown): Promise<string | undefined> {
  if (!validPageShotId(id)) throw new Error('Invalid page shot id');
  let directory: string;
  try { directory = await shotDirectory(); } catch (error) { if (missingFile(error)) return undefined; throw error; }
  for (const extension of ['png', 'jpg'] as const) {
    const path = await confinedShot(directory, id, extension);
    if (!path) continue;
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_PAGE_SHOT_BYTES) throw new Error('Page shot exceeds image size limit');
      // A bounded read also covers a file growing after stat.
      const buffer = Buffer.alloc(Math.min(MAX_PAGE_SHOT_BYTES + 1, info.size + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PAGE_SHOT_BYTES || bytesRead !== info.size) throw new Error('Page shot changed during read');
      return `data:image/${extension === 'jpg' ? 'jpeg' : 'png'};base64,${buffer.subarray(0, bytesRead).toString('base64')}`;
    } finally { await file.close(); }
  }
  return undefined;
}

export async function deletePageShots(ids: unknown): Promise<void> {
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every(validPageShotId)) throw new Error('Invalid page shot ids');
  let directory: string;
  try { directory = await shotDirectory(); } catch (error) { if (missingFile(error)) return; throw error; }
  for (const id of new Set(ids)) {
    for (const extension of ['png', 'jpg'] as const) {
      const path = await confinedShot(directory, id, extension);
      if (path) await unlink(path).catch((error: unknown) => { if (!missingFile(error)) throw error; });
    }
  }
}

async function cleanupPageShots(): Promise<void> {
  const directory = await shotDirectory();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(.+)\.(png|jpg)$/.exec(entry.name);
    if (!match || !validPageShotId(match[1])) continue;
    try {
      const path = await confinedShot(directory, match[1], match[2] as 'png' | 'jpg');
      if (path && (await lstat(path)).mtimeMs < cutoff) await unlink(path);
    } catch { /* A busy or removed shot can be retried next startup. */ }
  }
}

async function captureShot(sender: WebContents, frameRect: PageRect, pick: PagePick): Promise<PageShot | undefined> {
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || sender.isDestroyed()) return undefined;
  const [width, height] = window.getContentSize();
  const rect = pageCaptureRect(frameRect, pick.target.rect, pick.viewport, sender.getZoomFactor(), { width, height });
  if (!rect) return undefined;
  let image = await sender.capturePage(rect);
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  const resized = pageImageSize(size.width, size.height, 1600);
  if (resized.width !== size.width || resized.height !== size.height) image = image.resize({ ...resized, quality: 'best' });
  const png = image.toPNG();
  let extension: 'png' | 'jpg' = png.length <= 600 * 1024 ? 'png' : 'jpg';
  let bytes = extension === 'png' ? png : image.toJPEG(85);
  let stored = image;
  let storedSize = resized;
  // A screenshot must always remain readable by the image-transfer path. JPEG may exceed the
  // Chat attachment limit for noisy images even after the normal 1600 px downscale.
  while (bytes.length > MAX_PAGE_SHOT_BYTES) {
    const next = { width: Math.max(1, Math.floor(storedSize.width * 0.8)), height: Math.max(1, Math.floor(storedSize.height * 0.8)) };
    if (next.width === storedSize.width && next.height === storedSize.height) return undefined;
    stored = stored.resize({ ...next, quality: 'best' });
    storedSize = next;
    extension = 'jpg';
    bytes = stored.toJPEG(85);
  }
  const thumbnail = stored.resize({ ...pageImageSize(storedSize.width, storedSize.height, 240), quality: 'good' }).toJPEG(70);
  const directory = await shotDirectory(true);
  const id = randomUUID();
  const path = pageShotPath(directory, id, extension);
  await writeFile(path, bytes, { flag: 'wx' });
  return { id, path, width: storedSize.width, height: storedSize.height, thumbnail: `data:image/jpeg;base64,${thumbnail.toString('base64')}` };
}

async function pickPageTarget(event: IpcMainInvokeEvent, value: unknown): Promise<PagePick | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid page pick request');
  const request = value as Record<string, unknown>;
  const frameRect = pageRect(request.frameRect);
  const sender = event.sender;
  const frame = findFrame(sender, request.frameName);
  const key = `${sender.id}:${request.frameName}`;
  pendingPicks.get(key)?.cancel();
  if (!frame) return null;
  let resolveCancellation!: (value: null) => void;
  const cancellation = new Promise<null>((done) => { resolveCancellation = done; });
  const pending: PendingPick = { frame, cancelled: false, cancel: () => {
    if (pending.cancelled) return;
    pending.cancelled = true;
    resolveCancellation(null);
  } };
  pendingPicks.set(key, pending);
  const processId = frame.processId;
  const routingId = frame.routingId;
  const navigated = (_event: Electron.Event, _url: string, _code: number, _status: string, main: boolean, pid: number, rid: number) => {
    if (main || (pid === processId && rid === routingId) || frame.detached) pending.cancel();
  };
  const navigating = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!details.isSameDocument && (details.isMainFrame || details.frame === frame)) pending.cancel();
  };
  const destroyed = () => pending.cancel();
  sender.on('did-frame-navigate', navigated);
  sender.on('did-start-navigation', navigating);
  sender.once('destroyed', destroyed);
  const gone = setInterval(() => {
    if (sender.isDestroyed() || frame.detached || !sender.mainFrame.framesInSubtree.includes(frame)) pending.cancel();
  }, 150);
  gone.unref();
  try {
    const raw = await Promise.race([frame.executeJavaScript(pagePickerSource('pick'), false), cancellation]);
    if (pending.cancelled || frame.detached) return null;
    const pick = sanitizePagePick(raw);
    if (!pick) return null;
    const capture = captureShot(sender, frameRect, pick).then(async (shot) => {
      if (pending.cancelled || frame.detached) {
        if (shot) await deletePageShots([shot.id]);
        return undefined;
      }
      return shot;
    });
    const shot = await Promise.race([capture, cancellation]);
    if (pending.cancelled || frame.detached) return null;
    return { ...pick, ...(shot ? { shot } : {}) };
  } catch (error) {
    if (pending.cancelled || sender.isDestroyed() || frame.detached) return null;
    throw error;
  } finally {
    clearInterval(gone);
    sender.removeListener('did-frame-navigate', navigated);
    sender.removeListener('did-start-navigation', navigating);
    sender.removeListener('destroyed', destroyed);
    if (pendingPicks.get(key) === pending) pendingPicks.delete(key);
  }
}

export function registerPageComments(assertTrustedRenderer: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle('threadterm:pick-page-target', async (event, request: unknown) => { assertTrustedRenderer(event); return pickPageTarget(event, request); });
  ipcMain.handle('threadterm:cancel-page-pick', async (event, name: unknown) => {
    assertTrustedRenderer(event);
    const frame = findFrame(event.sender, name);
    pendingPicks.get(`${event.sender.id}:${name}`)?.cancel();
    if (frame) await frame.executeJavaScript(pagePickerSource('cancel'), false).catch(() => undefined);
  });
  ipcMain.handle('threadterm:mark-page-target', async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid page mark request');
    const request = value as Record<string, unknown>;
    const frame = findFrame(event.sender, request.frameName);
    const target = sanitizePageTargetRef(request.target);
    if (request.flash !== undefined && typeof request.flash !== 'boolean') throw new Error('Invalid page flash flag');
    if (!frame) return false;
    return frame.executeJavaScript(pagePickerSource('mark', target, request.flash as boolean | undefined), false).then((result: unknown) => result === true, () => false);
  });
  ipcMain.handle('threadterm:read-page-shot', async (event, id: unknown) => { assertTrustedRenderer(event); return readPageShot(id); });
  ipcMain.handle('threadterm:delete-page-shots', async (event, ids: unknown) => { assertTrustedRenderer(event); return deletePageShots(ids); });
  void cleanupPageShots().catch(() => undefined);
}
