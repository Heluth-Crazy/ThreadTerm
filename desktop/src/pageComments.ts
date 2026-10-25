import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { PagePick, PageRect, PageShot } from '@threadterm/protocol';
import { MAX_PAGE_SHOT_BYTES, pageCaptureRect, pageImageSize, pageRect, pageShotPath, sanitizePagePick, sanitizePageTargetRef, validPageFrameName, validPageShotId } from './pageCommentsCore.js';
import { pagePickerSource } from './pagePickerScript.js';

type PendingPick = { frame: WebFrameMain; cancel: () => void; cancelled: boolean };
type PageShotReferenceCatalog = { paths: readonly string[]; nextAfter?: string; legacyImportComplete: boolean };
type PageShotReferenceReader = (after?: string) => Promise<PageShotReferenceCatalog>;
type DeletePageShotOptions = { force?: boolean; assetReferences?: PageShotReferenceReader };
const pendingPicks = new Map<string, PendingPick>();
/** Native browser pages are deliberately registered by the browser owner, keyed to the trusted app renderer.
 * FilePreview continues to use the iframe lookup below. */
type NativePage = { contents: WebContents; bounds: () => PageRect | undefined };
const nativePages = new Map<string, NativePage>();
const nativeKey = (sender: WebContents, frameName: string) => `${sender.id}:${frameName}`;
export function nativePageRegistered(sender: WebContents, frameName: string, contents: WebContents, bounds: () => PageRect | undefined): void { nativePages.set(nativeKey(sender, frameName), { contents, bounds }); }
export function nativePageClosed(sender: WebContents, frameName: string): void { const key=nativeKey(sender,frameName),native=nativePages.get(key);pendingPicks.get(key)?.cancel();nativePages.delete(key);if(native&&!native.contents.isDestroyed())void native.contents.executeJavaScriptInIsolatedWorld(999,[{code:pagePickerSource('cancel')}],false).catch(()=>undefined); }

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

function pathKey(path: string): string {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function referencedShotPaths(directory: string, assetReferences: PageShotReferenceReader | undefined): Promise<Set<string> | undefined> {
  if (!assetReferences) return undefined;
  try {
    const parent = pathKey(directory), references = new Set<string>(), cursors = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const catalog = await assetReferences(after);
      if (!catalog?.legacyImportComplete || !Array.isArray(catalog.paths) || !catalog.paths.every(path => typeof path === 'string')) return undefined;
      for (const path of catalog.paths) {
        const resolved = resolve(path), name = resolved.slice(Math.max(resolved.lastIndexOf('\\'), resolved.lastIndexOf('/')) + 1), match = /^(.+)\.(png|jpg)$/i.exec(name);
        if (match && validPageShotId(match[1]) && pathKey(dirname(resolved)) === parent) references.add(pathKey(resolved));
      }
      if (catalog.nextAfter === undefined) return references;
      if (typeof catalog.nextAfter !== 'string' || !catalog.nextAfter || cursors.has(catalog.nextAfter)) return undefined;
      cursors.add(catalog.nextAfter);
      after = catalog.nextAfter;
    }
  } catch { return undefined; }
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

export async function deletePageShots(ids: unknown, options: DeletePageShotOptions = {}): Promise<void> {
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every(validPageShotId)) throw new Error('Invalid page shot ids');
  let directory: string;
  try { directory = await shotDirectory(); } catch (error) { if (missingFile(error)) return; throw error; }
  const references = options.force ? new Set<string>() : await referencedShotPaths(directory, options.assetReferences);
  if (!references) return;
  for (const id of new Set(ids)) {
    for (const extension of ['png', 'jpg'] as const) {
      const path = await confinedShot(directory, id, extension);
      if (path && !references.has(pathKey(path))) await unlink(path).catch((error: unknown) => { if (!missingFile(error)) throw error; });
    }
  }
}

async function cleanupPageShots(assetReferences: PageShotReferenceReader | undefined): Promise<void> {
  const directory = await shotDirectory();
  const references = await referencedShotPaths(directory, assetReferences);
  if (!references) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(.+)\.(png|jpg)$/.exec(entry.name);
    if (!match || !validPageShotId(match[1])) continue;
    try {
      const path = await confinedShot(directory, match[1], match[2] as 'png' | 'jpg');
      if (path && !references.has(pathKey(path)) && (await lstat(path)).mtimeMs < cutoff) await unlink(path);
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
  const native = typeof request.frameName === 'string' ? nativePages.get(nativeKey(sender, request.frameName)) : undefined;
  if(native){const pick=await pickNativePage(native,sender,String(request.frameName));if(!sender.isDestroyed()&&BrowserWindow.fromWebContents(sender)?.isFocused())sender.focus();return pick;}
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
        if (shot) await deletePageShots([shot.id], { force: true });
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

async function pickNativePage(native: NativePage, sender: WebContents, frameName: string): Promise<PagePick | null> {
  const contents = native.contents;
  if (contents.isDestroyed()) return null;
  const key = nativeKey(sender, frameName);
  const old = pendingPicks.get(key); old?.cancel();
  let done!: (value: null) => void;
  const cancelled = new Promise<null>(resolve => { done = resolve; });
  const pending: PendingPick = { frame: contents.mainFrame, cancelled: false, cancel: () => { if (!pending.cancelled) { pending.cancelled = true; done(null); } } };
  pendingPicks.set(key, pending);
  const navigating=(details:Electron.Event<Electron.WebContentsDidStartNavigationEventParams>)=>{if(details.isMainFrame&&!details.isSameDocument)pending.cancel();},destroyed=()=>pending.cancel();contents.on('did-start-navigation',navigating);contents.once('destroyed',destroyed);
  try {
    const raw = await Promise.race([contents.executeJavaScriptInIsolatedWorld(999, [{ code: pagePickerSource('pick') }], false), cancelled]);
    if (pending.cancelled || contents.isDestroyed()) return null;
    const pick = sanitizePagePick(raw); if (!pick) return null;
    const capture = captureNativePageShot(contents, pick).then(async shot => {
      if (pending.cancelled && shot) { await deletePageShots([shot.id], { force: true }); return undefined; }
      return shot;
    });
    const shot = await Promise.race([capture, cancelled]);
    return pending.cancelled ? null : { ...pick, ...(shot ? { shot } : {}) };
  } finally {
    contents.removeListener('did-start-navigation', navigating); contents.removeListener('destroyed', destroyed);
    if (pendingPicks.get(key) === pending) pendingPicks.delete(key);
  }
}

export async function captureNativePageShot(contents: WebContents, pick: PagePick): Promise<PageShot | undefined> {
  if (contents.isDestroyed()) return undefined;
  let image = await contents.capturePage(undefined,{stayHidden:true,stayAwake:false}); if (image.isEmpty()) return undefined;
  const size=image.getSize(), target=pick.target.rect;
  if (target && target.width > 0 && target.height > 0) {
    const scaleX=size.width/Math.max(1,pick.viewport.width),scaleY=size.height/Math.max(1,pick.viewport.height),x=Math.max(0,Math.min(size.width-1,Math.floor(target.x*scaleX))),y=Math.max(0,Math.min(size.height-1,Math.floor(target.y*scaleY))),width=Math.max(1,Math.min(size.width-x,Math.ceil(target.width*scaleX))),height=Math.max(1,Math.min(size.height-y,Math.ceil(target.height*scaleY)));
    image=image.crop({x,y,width,height});
  }
  const resized=pageImageSize(image.getSize().width,image.getSize().height,1600); image=image.resize({ ...resized, quality:'best' });
  let bytes=image.toPNG(), extension:'png'|'jpg'='png'; if(bytes.length>600*1024){extension='jpg';bytes=image.toJPEG(85);}
  while(bytes.length>MAX_PAGE_SHOT_BYTES){const s=image.getSize();if(s.width===1&&s.height===1)return undefined;image=image.resize({width:Math.max(1,Math.floor(s.width*.8)),height:Math.max(1,Math.floor(s.height*.8)),quality:'best'});extension='jpg';bytes=image.toJPEG(85);}
  const directory=await shotDirectory(true),id=randomUUID(),path=pageShotPath(directory,id,extension);await writeFile(path,bytes,{flag:'wx'});
  const shotSize=image.getSize(),thumbnail=image.resize({ ...pageImageSize(shotSize.width,shotSize.height,240), quality:'good'}).toJPEG(70);
  return {id,path,width:shotSize.width,height:shotSize.height,thumbnail:`data:image/jpeg;base64,${thumbnail.toString('base64')}`};
}

async function previewFrameInfo(sender: WebContents, name: string): Promise<{ rect: PageRect; staticFrame: boolean } | undefined> {
  const source = `(()=>{const f=[...document.querySelectorAll('iframe')].find(v=>v.name===${JSON.stringify(name)});if(!f)return null;const r=f.getBoundingClientRect();return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},staticFrame:f.src.startsWith('about:srcdoc')||f.hasAttribute('srcdoc')};})()`;
  try { const value = await sender.mainFrame.executeJavaScript(source, false) as { rect?: unknown; staticFrame?: unknown }; return typeof value?.staticFrame === 'boolean' ? { rect: pageRect(value.rect), staticFrame: value.staticFrame } : undefined; } catch { return undefined; }
}

export function registerPageComments(
  assertTrustedRenderer: (event: IpcMainInvokeEvent) => void,
  assetReferences?: PageShotReferenceReader,
): void {
  app.on('web-contents-created', (_event, contents) => {
    let latestContext = 0;
    contents.on('context-menu', (_menuEvent, params) => {
      const frame = params.frame;
      if (!frame || frame.detached || frame.parent !== contents.mainFrame || !validPageFrameName(frame.name) || !contents.mainFrame.framesInSubtree.includes(frame)) return;
      const frameName = frame.name;
      const dipX = Number(params.x), dipY = Number(params.y), zoom = contents.getZoomFactor();
      // Chromium supplies context-menu positions in DIP (WebLocalFrameImpl::ShowContextMenu); DOM rects are CSS px.
      if (!Number.isFinite(dipX) || !Number.isFinite(dipY) || !Number.isFinite(zoom) || zoom <= 0) return;
      const x = dipX / zoom, y = dipY / zoom;
      const sequence = ++latestContext, frameUrl = frame.url;
      let cancelled = false;
      const navigating = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
        if (!details.isSameDocument && (details.isMainFrame || details.frame === frame)) cancelled = true;
      };
      const navigated = (_event: Electron.Event, _url: string, _code: number, _status: string, main: boolean, pid: number, rid: number) => {
        if (main || pid === frame.processId && rid === frame.routingId) cancelled = true;
      };
      const current = () => !cancelled && sequence === latestContext && !contents.isDestroyed() && !frame.detached && frame.name === frameName && frame.url === frameUrl && frame.parent === contents.mainFrame && contents.mainFrame.framesInSubtree.includes(frame);
      contents.on('did-start-navigation', navigating);
      contents.on('did-frame-navigate', navigated);
      void (async () => {
        const info = await previewFrameInfo(contents, frameName), rect = info?.rect;
        if (!current() || !rect || x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) return;
        const selectionText = typeof params.selectionText === 'string' ? params.selectionText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ').slice(0, 10000) : '';
        if (info.staticFrame) { contents.send('threadterm:page-context-menu', { frameName, x, y, staticFrame: true, selectionText }); return; }
        const pick = sanitizePagePick(await frame.executeJavaScript(pagePickerSource('at', undefined, undefined, { x: x - rect.x, y: y - rect.y }), false));
        if (!pick || !current()) return;
        const shot = await captureShot(contents, rect, pick);
        if (!current()) { if (shot) await deletePageShots([shot.id], { force: true }); return; }
        contents.send('threadterm:page-context-menu', { frameName, x, y, pick: { ...pick, ...(shot ? { shot } : {}) }, selectionText });
      })().catch(() => undefined).finally(() => {
        contents.removeListener('did-start-navigation', navigating);
        contents.removeListener('did-frame-navigate', navigated);
      });
    });
  });
  ipcMain.handle('threadterm:pick-page-target', async (event, request: unknown) => { assertTrustedRenderer(event); return pickPageTarget(event, request); });
  ipcMain.handle('threadterm:cancel-page-pick', async (event, name: unknown) => {
    assertTrustedRenderer(event);
    const frame = findFrame(event.sender, name);
    pendingPicks.get(`${event.sender.id}:${name}`)?.cancel();
    const native = typeof name === 'string' ? nativePages.get(nativeKey(event.sender, name)) : undefined;
    if (native && !native.contents.isDestroyed()) await native.contents.executeJavaScriptInIsolatedWorld(999, [{ code: pagePickerSource('cancel') }], false).catch(() => undefined);
    if (frame) await frame.executeJavaScript(pagePickerSource('cancel'), false).catch(() => undefined);
  });
  ipcMain.handle('threadterm:mark-page-target', async (event, value: unknown) => {
    assertTrustedRenderer(event);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid page mark request');
    const request = value as Record<string, unknown>;
    const frame = findFrame(event.sender, request.frameName);
    const target = sanitizePageTargetRef(request.target);
    if (request.flash !== undefined && typeof request.flash !== 'boolean') throw new Error('Invalid page flash flag');
    const native = typeof request.frameName === 'string' ? nativePages.get(nativeKey(event.sender, request.frameName)) : undefined;
    if (native && !native.contents.isDestroyed()) return native.contents.executeJavaScriptInIsolatedWorld(999, [{ code: pagePickerSource('mark', target, request.flash as boolean | undefined) }], false).then((result: unknown) => result === true, () => false);
    if (!frame) return false;
    return frame.executeJavaScript(pagePickerSource('mark', target, request.flash as boolean | undefined), false).then((result: unknown) => result === true, () => false);
  });
  ipcMain.handle('threadterm:read-page-shot', async (event, id: unknown) => { assertTrustedRenderer(event); return readPageShot(id); });
  ipcMain.handle('threadterm:delete-page-shots', async (event, ids: unknown) => { assertTrustedRenderer(event); return deletePageShots(ids, { assetReferences }); });
  void cleanupPageShots(assetReferences).catch(() => undefined);
}
