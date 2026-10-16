import { BrowserAgentGrants } from './agentGrants.js';
import { BrowserAgentSnapshotRefs, buildBrowserAgentSnapshot, type BrowserAgentAXNode } from './agentSnapshot.js';
import { BROWSER_AGENT_IMAGE_BYTES, BROWSER_AGENT_IMAGE_EDGE, BROWSER_AGENT_READ_DATA_BYTES, BROWSER_AGENT_THUMBNAIL_BYTES, BROWSER_AGENT_THUMBNAIL_EDGE, BrowserAgentError, assertBrowserAgentResultBound, browserAgentOrigin, browserAgentProvenance, clipBrowserAgentText, type BrowserAgentConsoleLevel, type BrowserAgentDebugger, type BrowserAgentImage, type BrowserAgentNativeTab, type BrowserAgentReadContext, type BrowserAgentReadTool } from './agentTypes.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const attachedReads = new WeakSet<BrowserAgentDebugger>();
const pendingCaptures = new WeakSet<BrowserAgentNativeTab['contents']>();

interface ReadScope {
  check(): BrowserAgentNativeTab;
  wait<T>(pending: Promise<T>): Promise<T>;
  onCleanup(callback: () => void): void;
}

async function scopedRead<T>(grants: BrowserAgentGrants, context: BrowserAgentReadContext, read: (scope: ReadScope) => Promise<T>): Promise<T> {
  let initial: BrowserAgentNativeTab['contents'] | undefined;
  const cleanup: (() => void)[] = [];
  let ended = false, rejectStopped: (error: Error) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  let stoppedError: BrowserAgentError | undefined;
  // Install a rejection observer even if an early synchronous check fails.
  void stopped.catch(() => undefined);
  const check = (): BrowserAgentNativeTab => {
    if (stoppedError) throw stoppedError;
    if (context.signal?.aborted) throw new BrowserAgentError('browser_cancelled', 'Browser read was cancelled.');
    if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) throw new BrowserAgentError('browser_deadline', 'Browser read deadline expired.');
    context.assertAuthorized();
    const tab = context.getTab();
    if (!tab || tab.contents.isDestroyed()) throw new BrowserAgentError('browser_unavailable', 'The shared browser view is unavailable.');
    grants.assertRead(context.fence, tab.document);
    if (initial && tab.contents !== initial) throw new BrowserAgentError('browser_unavailable', 'The shared browser view was replaced.');
    initial ??= tab.contents;
    return tab;
  };
  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const callback of cleanup.splice(0).reverse()) { try { callback(); } catch { /* Cleanup never changes the read outcome. */ } }
  };
  const stop = (error: BrowserAgentError): void => { stoppedError = error; rejectStopped(error); finish(); };
  const abort = (): void => stop(new BrowserAgentError('browser_cancelled', 'Browser read was cancelled.'));
  try {
    check();
    const timer = setTimeout(() => stop(new BrowserAgentError('browser_deadline', 'Browser read deadline expired.')), Math.max(1, Math.min(context.deadline - Date.now(), 10_000)));
    cleanup.push(() => clearTimeout(timer));
    context.signal?.addEventListener('abort', abort, { once: true });
    cleanup.push(() => context.signal?.removeEventListener('abort', abort));
    const scope: ReadScope = {
      check,
      async wait(pending) { check(); const result = await Promise.race([pending, stopped]); check(); return result; },
      onCleanup(callback) { if (ended) callback(); else cleanup.push(callback); },
    };
    const result = await scope.wait(read(scope));
    check(); assertBrowserAgentResultBound(result);
    return result;
  } catch (error) {
    if (error instanceof BrowserAgentError) throw error;
    throw new BrowserAgentError('browser_read_failed', 'The browser read failed.');
  } finally { finish(); }
}

interface CdpScope {
  command(method: string, params?: JsonObject): Promise<unknown>;
  listen(listener: (method: string, params: JsonObject) => void): void;
}

async function withCdp<T>(scope: ReadScope, read: (cdp: CdpScope) => Promise<T>): Promise<T> {
  const debuggerClient = scope.check().contents.debugger;
  if (debuggerClient.isAttached() || attachedReads.has(debuggerClient)) throw new BrowserAgentError('browser_unavailable', 'Browser inspection is unavailable while another debugger is attached.');
  let owned = false, detached = false;
  const listeners: ((...args: any[]) => void)[] = [];
  let rejectDetached: (error: Error) => void = () => undefined;
  const detachment = new Promise<never>((_resolve, reject) => { rejectDetached = reject; });
  void detachment.catch(() => undefined);
  const onDetach = (): void => { owned = false; detached = true; rejectDetached(new BrowserAgentError('browser_unavailable', 'Browser inspection was detached.')); };
  debuggerClient.on('detach', onDetach);
  scope.onCleanup(() => {
    for (const listener of listeners) debuggerClient.removeListener('message', listener);
    // A detach event relinquishes ownership even if another debugger has attached since.
    try { if (owned && debuggerClient.isAttached()) { owned = false; debuggerClient.detach(); } }
    finally { debuggerClient.removeListener('detach', onDetach); attachedReads.delete(debuggerClient); }
  });
  try {
    debuggerClient.attach('1.3');
    if (detached || !debuggerClient.isAttached()) throw new BrowserAgentError('browser_unavailable', 'Browser inspection was detached.');
    owned = true; attachedReads.add(debuggerClient);
  } catch { throw new BrowserAgentError('browser_unavailable', 'The browser debugger could not be attached.'); }
  const assertAttached = (): void => {
    scope.check();
    if (detached || !owned || !debuggerClient.isAttached()) throw new BrowserAgentError('browser_unavailable', 'Browser inspection was detached.');
  };
  return read({
    async command(method, params) { assertAttached(); const result = await scope.wait(Promise.race([debuggerClient.sendCommand(method, params), detachment])); assertAttached(); return result; },
    listen(listener) {
      const eventListener = (_event: unknown, method: string, params: unknown): void => { if (owned && !detached) listener(method, object(params)); };
      listeners.push(eventListener); debuggerClient.on('message', eventListener);
    },
  });
}

interface FrameIdentity { id: string; origin: string; loaderId: string; parentId: string }
function framesFromTree(value: unknown): Map<string, FrameIdentity> {
  const result = new Map<string, FrameIdentity>();
  const pending = [object(object(value).frameTree)];
  while (pending.length && result.size < 256) {
    const tree = pending.pop()!, frame = object(tree.frame), id = string(frame.id), urlOrigin = browserAgentOrigin(string(frame.url));
    const securityOrigin = string(frame.securityOrigin);
    if (id && urlOrigin && (!securityOrigin || securityOrigin === urlOrigin)) result.set(id, { id, origin: urlOrigin, loaderId: string(frame.loaderId), parentId: string(frame.parentId) });
    const children = Array.isArray(tree.childFrames) ? tree.childFrames : [];
    for (const child of children.slice(0, 256).reverse()) pending.push(object(child));
  }
  return result;
}

export interface BrowserAgentConsoleEntry { level: BrowserAgentConsoleLevel; text: string; sourceUrl: string; line: number }
export interface BrowserAgentConsoleResult {
  provenance: ReturnType<typeof browserAgentProvenance>;
  entries: BrowserAgentConsoleEntry[];
  truncated: boolean;
  omitted: number;
  note: string;
}

function consoleLevel(type: unknown): BrowserAgentConsoleLevel | undefined {
  if (type === 'warning' || type === 'warn') return 'warning';
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'debug') return 'debug';
  if (type === 'info') return 'info';
  if (['log', 'dir', 'dirxml', 'table', 'trace', 'startGroup', 'startGroupCollapsed', 'endGroup', 'clear', 'count', 'timeEnd'].includes(string(type))) return 'log';
  return undefined;
}

function consoleArgument(value: unknown, truncated: () => void): string {
  const argument = object(value);
  if (['string', 'number', 'boolean'].includes(string(argument.type)) && ['string', 'number', 'boolean'].includes(typeof argument.value)) {
    const text = String(argument.value), clipped = clipBrowserAgentText(text, 8192);
    if (text !== clipped) truncated();
    return clipped;
  }
  if (argument.subtype === 'null') return 'null';
  if (argument.type === 'undefined') return 'undefined';
  if (argument.type === 'number' && /^(NaN|-?Infinity|-0)$/.test(string(argument.unserializableValue))) return string(argument.unserializableValue);
  return '[object omitted]';
}

async function readConsole(scope: ReadScope, context: BrowserAgentReadContext, level?: BrowserAgentConsoleLevel): Promise<BrowserAgentConsoleResult> {
  return withCdp(scope, async cdp => {
    const before = framesFromTree(await cdp.command('Page.getFrameTree'));
    type ContextIdentity = { frameId: string; origin: string };
    const contexts = new Map<number, ContextIdentity>();
    const pending: { contextId: number; context: ContextIdentity; entry: BrowserAgentConsoleEntry }[] = [];
    let omitted = 0, truncated = false, bytes = 0;
    cdp.listen((method, params) => {
      if (method === 'Runtime.executionContextCreated') {
        const ctx = object(params.context), aux = object(ctx.auxData), id = ctx.id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || aux.isDefault !== true || contexts.size >= 512) return;
        contexts.set(id, { frameId: string(aux.frameId), origin: string(ctx.origin) });
      } else if (method === 'Runtime.executionContextDestroyed') {
        if (typeof params.executionContextId === 'number') contexts.delete(params.executionContextId);
      } else if (method === 'Runtime.executionContextsCleared') contexts.clear();
      else if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
        const exception = object(params.exceptionDetails), contextId = method === 'Runtime.consoleAPICalled' ? params.executionContextId : exception.executionContextId;
        const entryLevel = method === 'Runtime.consoleAPICalled' ? consoleLevel(params.type) : 'error';
        if (typeof contextId !== 'number' || !Number.isSafeInteger(contextId) || !entryLevel) { omitted++; return; }
        if (level && level !== entryLevel) return;
        const currentContext = contexts.get(contextId);
        if (!currentContext) { omitted++; return; }
        if (pending.length >= 200 || bytes >= 64 * 1024) { omitted++; truncated = true; return; }
        const allArgs = Array.isArray(params.args) ? params.args : [], args = allArgs.slice(0, 32);
        if (allArgs.length > args.length) truncated = true;
        const fullText = method === 'Runtime.consoleAPICalled' ? args.map(argument => consoleArgument(argument, () => { truncated = true; })).join(' ') : string(exception.text);
        const text = clipBrowserAgentText(fullText, 16 * 1024);
        if (text !== fullText) truncated = true;
        const stack = object(method === 'Runtime.consoleAPICalled' ? params.stackTrace : exception.stackTrace), callFrame = object(Array.isArray(stack.callFrames) ? stack.callFrames[0] : undefined);
        const fullSourceUrl = string(callFrame.url) || string(exception.url), sourceUrl = clipBrowserAgentText(fullSourceUrl, 2048);
        if (fullSourceUrl !== sourceUrl) truncated = true;
        const rawLine = callFrame.lineNumber ?? exception.lineNumber;
        const line = typeof rawLine === 'number' && Number.isSafeInteger(rawLine) && rawLine >= 0 ? rawLine + 1 : 0;
        const entry = { level: entryLevel, text, sourceUrl, line };
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8'); pending.push({ contextId, context: currentContext, entry });
      }
    });
    // Runtime.enable supplies existing context identities and may replay cached console events.
    await cdp.command('Runtime.enable');
    const after = framesFromTree(await cdp.command('Page.getFrameTree'));
    const result: BrowserAgentConsoleResult = { provenance: browserAgentProvenance(context.fence), entries: [], truncated, omitted, note: 'Only messages with a verified current same-origin default frame context are included. Ambiguous contexts and object properties are omitted.' };
    result.truncated ||= result.provenance.truncated;
    let resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const sameOriginChain = (id: string, frames: Map<string, FrameIdentity>): boolean => {
      const seen = new Set<string>();
      while (id && !seen.has(id) && seen.size < 256) {
        seen.add(id);
        const frame = frames.get(id);
        if (!frame || frame.origin !== context.fence.origin) return false;
        id = frame.parentId;
      }
      return !id;
    };
    for (const { contextId, context: capturedContext, entry } of pending) {
      const ctx = contexts.get(contextId), first = ctx && before.get(ctx.frameId), last = ctx && after.get(ctx.frameId);
      if (!ctx || ctx !== capturedContext || !first || !last || !first.loaderId || first.loaderId !== last.loaderId || first.parentId !== last.parentId || ctx.origin !== context.fence.origin || !sameOriginChain(ctx.frameId, before) || !sameOriginChain(ctx.frameId, after)) { result.omitted++; continue; }
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
      if (resultBytes + size + 128 >= BROWSER_AGENT_READ_DATA_BYTES) { result.omitted++; result.truncated = true; continue; }
      result.entries.push(entry); resultBytes += size;
    }
    assertBrowserAgentResultBound(result, BROWSER_AGENT_READ_DATA_BYTES);
    return result;
  });
}

export interface BrowserAgentScreenshotResult {
  provenance: ReturnType<typeof browserAgentProvenance>;
  mimeType: 'image/png' | 'image/jpeg';
  data: string;
  width: number;
  height: number;
}

export function encodeBrowserAgentScreenshot(image: BrowserAgentImage, context: Pick<BrowserAgentReadContext, 'fence'>): BrowserAgentScreenshotResult {
  if (image.isEmpty()) throw new BrowserAgentError('browser_read_failed', 'The browser screenshot was empty.');
  let current = image, size = current.getSize();
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1) throw new BrowserAgentError('browser_read_failed', 'The browser screenshot dimensions were invalid.');
  const ratio = Math.min(1, BROWSER_AGENT_IMAGE_EDGE / Math.max(size.width, size.height));
  if (ratio < 1) { size = { width: Math.max(1, Math.floor(size.width * ratio)), height: Math.max(1, Math.floor(size.height * ratio)) }; current = current.resize({ ...size, quality: 'best' }); }
  let encoded = current.toPNG(), mimeType: BrowserAgentScreenshotResult['mimeType'] = 'image/png';
  if (encoded.length > BROWSER_AGENT_IMAGE_BYTES) { encoded = current.toJPEG(80); mimeType = 'image/jpeg'; }
  for (let attempt = 0; encoded.length > BROWSER_AGENT_IMAGE_BYTES && attempt < 12; attempt++) {
    const next = { width: Math.max(1, Math.floor(size.width * 0.75)), height: Math.max(1, Math.floor(size.height * 0.75)) };
    if (next.width === size.width && next.height === size.height) break;
    current = current.resize({ ...next, quality: 'best' }); size = next; encoded = current.toJPEG(75); mimeType = 'image/jpeg';
  }
  if (!encoded.length || encoded.length > BROWSER_AGENT_IMAGE_BYTES) throw new BrowserAgentError('browser_read_failed', 'The browser screenshot exceeded its image size limit.');
  // Reencode a separate small preview; full image bytes never enter activity metadata.
  const thumbnailRatio = Math.min(1, BROWSER_AGENT_THUMBNAIL_EDGE / Math.max(size.width, size.height));
  let thumbnailSize = { width: Math.max(1, Math.floor(size.width * thumbnailRatio)), height: Math.max(1, Math.floor(size.height * thumbnailRatio)) };
  let thumbnailImage = current.resize({ ...thumbnailSize, quality: 'best' }), thumbnail = thumbnailImage.toJPEG(65);
  for (let attempt = 0; thumbnail.length > BROWSER_AGENT_THUMBNAIL_BYTES && attempt < 12; attempt++) {
    const next = { width: Math.max(1, Math.floor(thumbnailSize.width * 0.75)), height: Math.max(1, Math.floor(thumbnailSize.height * 0.75)) };
    if (next.width === thumbnailSize.width && next.height === thumbnailSize.height) break;
    thumbnailSize = next; thumbnailImage = thumbnailImage.resize({ ...next, quality: 'best' }); thumbnail = thumbnailImage.toJPEG(55);
  }
  if (!thumbnail.length || thumbnail.length > BROWSER_AGENT_THUMBNAIL_BYTES) throw new BrowserAgentError('browser_read_failed', 'The browser screenshot preview exceeded its size limit.');
  const result = { provenance: { ...browserAgentProvenance(context.fence), thumbnail: `data:image/jpeg;base64,${thumbnail.toString('base64')}` }, mimeType, data: encoded.toString('base64'), ...size };
  assertBrowserAgentResultBound(result);
  return result;
}

/** The caller owns scheduling; this leaf never opens, reloads, selects or focuses a tab. */
export async function readBrowserAgentTool(grants: BrowserAgentGrants, refs: BrowserAgentSnapshotRefs, context: BrowserAgentReadContext, tool: BrowserAgentReadTool, level?: BrowserAgentConsoleLevel): Promise<unknown> {
  return scopedRead(grants, context, async scope => {
    if (level !== undefined && !['error', 'warning', 'info', 'debug', 'log'].includes(level)) throw new BrowserAgentError('browser_invalid_arguments', 'Unsupported browser console level.');
    if (tool === 'browser_screenshot') {
      const captureTab = (): BrowserAgentNativeTab => { const tab = scope.check(); if (tab.canCaptureScreenshot === false) throw new BrowserAgentError('browser_unavailable', 'Browser screenshots are unavailable while the app window is hidden or minimized.'); return tab; };
      const { contents } = captureTab();
      if (pendingCaptures.has(contents)) throw new BrowserAgentError('browser_unavailable', 'A browser screenshot capture is still pending.');
      pendingCaptures.add(contents);
      let pending: Promise<BrowserAgentImage>;
      try { pending = contents.capturePage(undefined, { stayHidden: true, stayAwake: true }); }
      catch (error) { pendingCaptures.delete(contents); throw error; }
      // Electron exposes no native capture cancellation. A timed-out read must not start more captures.
      void pending.then(() => pendingCaptures.delete(contents), () => pendingCaptures.delete(contents));
      const image = await scope.wait(pending);
      captureTab(); const result = encodeBrowserAgentScreenshot(image, context); captureTab(); return result;
    }
    if (tool === 'browser_console_messages') return readConsole(scope, context, level);
    if (tool !== 'browser_snapshot') throw new BrowserAgentError('browser_invalid_arguments', 'Unsupported browser read tool.');
    return withCdp(scope, async cdp => {
      const tree = await cdp.command('Page.getFrameTree'), frames = framesFromTree(tree), rootId = string(object(object(object(tree).frameTree).frame).id), root = frames.get(rootId);
      if (!root || root.origin !== context.fence.origin) throw new BrowserAgentError('browser_unavailable', 'The current browser document frame is unavailable.');
      const response = object(await cdp.command('Accessibility.getFullAXTree', { frameId: rootId, depth: 32 }));
      const after = framesFromTree(await cdp.command('Page.getFrameTree')).get(rootId);
      if (!after || !root.loaderId || after.loaderId !== root.loaderId || after.origin !== root.origin) throw new BrowserAgentError('browser_stale_ref', 'The browser document changed during accessibility capture.');
      if (!Array.isArray(response.nodes)) throw new BrowserAgentError('browser_read_failed', 'Browser accessibility data was unavailable.');
      scope.check(); return buildBrowserAgentSnapshot(context.fence, rootId, response.nodes as BrowserAgentAXNode[], refs);
    });
  });
}
