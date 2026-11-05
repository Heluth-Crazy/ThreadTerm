import { performance } from 'node:perf_hooks';
import { isBrowserActionReceipt, isBrowserActionTool, isBrowserToolArguments, type BrowserActionError, type BrowserActionReceipt, type BrowserActionSource, type BrowserExecution, type BrowserPageKey } from '@threadterm/protocol';
import type { BrowserAgentNodeRef } from './agentSnapshot.js';
import { browserAgentOrigin, clipBrowserAgentText, type BrowserAgentControlFence, type BrowserAgentNativeTab } from './agentTypes.js';

type JsonObject = Record<string, unknown>;
type Request = Pick<BrowserExecution, 'tool' | 'arguments' | 'deadlineUnixMs'>;

export interface BrowserAgentActionContext {
  readonly fence: BrowserAgentControlFence;
  readonly source: BrowserActionSource;
  readonly signal?: AbortSignal;
  getTab(): BrowserAgentNativeTab | undefined;
  resolveRef(ref: string): BrowserAgentNodeRef;
  assertAuthorized(): void;
  /** The authenticated runtime must acknowledge admission before the first native mutation. */
  beforeDispatch(): Promise<void>;
  /** Main owns URL policy and the actual navigation lifecycle. */
  navigate?(url: string): Promise<{ sharingRevoked: boolean }>;
}

export interface BrowserAgentActionTicket {
  readonly result: Promise<BrowserActionReceipt>;
  /** Settles only after every issued native command has actually settled. */
  readonly settled: Promise<void>;
}

class ActionError extends Error {
  constructor(readonly code: BrowserActionError) { super(code); this.name = 'BrowserAgentActionError'; }
}

interface NativeIdentity { frameId: string; loaderId: string }
type NativeCommand = (method: string, params?: JsonObject) => Promise<unknown>;
type ActionCommand = (method: string, params?: JsonObject, options?: { focusObjectId?: string }) => Promise<unknown>;
interface ElementState {
  connected: boolean;
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  tag: string;
  type: string;
  editable: boolean;
  focusable: boolean;
  select: boolean;
}

const INSPECT_ELEMENT = `function(){
  const e=this, s=getComputedStyle(e), r=e.getBoundingClientRect(), tag=String(e.tagName||'').toLowerCase(), type=String(e.type||'').toLowerCase();
  const disabled=Boolean(e.disabled)||e.getAttribute('aria-disabled')==='true';
  const editable=Boolean(e.isContentEditable)||tag==='textarea'||tag==='input'&&!['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(type);
  const focusable=editable||tag==='select'||tag==='button'||tag==='a'&&Boolean(e.href)||Number(e.tabIndex)>=0;
  return {connected:Boolean(e.isConnected),visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'&&Number(s.opacity)!==0,disabled,readOnly:Boolean(e.readOnly),tag,type,editable,focusable,select:tag==='select'};
}`;
const CLEAR_EDITABLE = `function(){
  const e=this, tag=String(e.tagName||'').toLowerCase(), type=String(e.type||'').toLowerCase();
  if(!e.isConnected||e.disabled||e.readOnly||e.getAttribute('aria-disabled')==='true'||type==='file')return false;
  if(e.isContentEditable){e.focus();if(document.activeElement!==e)return false;const s=getSelection();if(!s)return false;const r=document.createRange();r.selectNodeContents(e);s.removeAllRanges();s.addRange(r);r.deleteContents();return true;}
  if(tag!=='input'&&tag!=='textarea')return false;e.focus();if(document.activeElement!==e)return false;e.value='';return true;
}`;
const IS_FOCUSED = `function(){return Boolean(this.isConnected&&document.activeElement===this);}`;
const SELECT_OPTIONS = `function(values){
  if(!this.isConnected||this.disabled||String(this.tagName||'').toLowerCase()!=='select'||!Array.isArray(values))return false;
  const wanted=new Set(values), options=Array.from(this.options||[]);if(wanted.size!==values.length||values.some(v=>typeof v!=='string')||values.some(v=>!options.some(o=>o.value===v&&!o.disabled)))return false;
  if(!this.multiple&&values.length>1)return false;for(const o of options)o.selected=wanted.has(o.value);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true;
}`;

const KEY_DATA: Record<BrowserPageKey, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }, PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
};

const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const sameIdentity = (a: NativeIdentity, b: NativeIdentity): boolean => a.frameId === b.frameId && a.loaderId === b.loaderId;
const mutatesPage = (method: string, params?: JsonObject): boolean => method === 'Input.dispatchMouseEvent' || method === 'Input.insertText'
  || method === 'Input.dispatchKeyEvent' || method === 'DOM.focus'
  || method === 'Runtime.callFunctionOn' && (params?.functionDeclaration === CLEAR_EDITABLE || params?.functionDeclaration === SELECT_OPTIONS);
const sameRegistration = (a: BrowserAgentControlFence['registration'], b: BrowserAgentControlFence['registration']): boolean =>
  a.tabId === b.tabId && a.sourceTabId === b.sourceTabId && a.attachmentId === b.attachmentId && a.attachmentGeneration === b.attachmentGeneration && a.runtimeEpoch === b.runtimeEpoch && a.viewGeneration === b.viewGeneration;

function captureRequest(request: Request): Request {
  const args = { ...request.arguments };
  if (Array.isArray(args.values)) args.values = Object.freeze([...args.values]);
  return Object.freeze({ ...request, arguments: Object.freeze(args) });
}

function source(context: BrowserAgentActionContext): BrowserActionSource {
  const value = Object.freeze({ title: clipBrowserAgentText(context.source.title, 512), url: context.fence.url, origin: context.fence.origin });
  if (context.source.url !== value.url || context.source.origin !== value.origin || !isBrowserActionReceipt({ outcome: 'completed', source: value })) throw new ActionError('browser_unavailable');
  return value;
}

function failure(code: BrowserActionError, dispatched: boolean, actionSource?: BrowserActionSource): BrowserActionReceipt {
  if (dispatched) return Object.freeze({ outcome: 'outcome_unknown', code: 'browser_outcome_unknown', ...(actionSource ? { source: actionSource } : {}) });
  const outcome = code === 'browser_cancelled' || code === 'browser_user_interrupted' ? 'cancelled' : 'failed';
  return Object.freeze({ outcome, code, ...(actionSource ? { source: actionSource } : {}) });
}

function errorCode(error: unknown): BrowserActionError {
  if (error instanceof ActionError) return error.code;
  const code = object(error).code;
  if (code === 'browser_stale_ref' || code === 'browser_unavailable' || code === 'browser_deadline' || code === 'browser_cancelled') return code;
  if (code === 'browser_grant_required' || code === 'browser_control_required') return 'browser_control_required';
  return 'browser_action_failed';
}

/** Conservative pinned-native adapter. Construction does not enable product capability. */
export class BrowserAgentActions {
  private readonly busy = new Set<BrowserAgentNativeTab['contents']>();
  private readonly active = new Map<BrowserAgentNativeTab['contents'], { sourceTabId: string; stop(): void; navigating?: boolean }>();
  private readonly idle = new Map<BrowserAgentNativeTab['contents'], { settled: Promise<void>; release(): void }>();
  private readonly quarantine = new Map<BrowserAgentNativeTab['contents'], { settled: Promise<void>; release(): void }>();
  private readonly destruction = new Map<BrowserAgentNativeTab['contents'], (error: Error) => void>();

  constructor(private readonly capability: { electronVersion: string; available(): boolean }, private readonly clock: { now(): number } = performance) {}

  isBusy(contents: BrowserAgentNativeTab['contents']): boolean { return this.busy.has(contents); }
  whenIdle(contents: BrowserAgentNativeTab['contents']): Promise<void> { return this.idle.get(contents)?.settled ?? Promise.resolve(); }
  invalidate(sourceTabId: string): void { for (const active of this.active.values()) if (active.sourceTabId === sourceTabId && !active.navigating) active.stop(); }
  clear(): void { for (const active of this.active.values()) active.stop(); }
  confirmDestroyed(contents: BrowserAgentNativeTab['contents']): boolean {
    if (!contents.isDestroyed()) return false;
    this.destruction.get(contents)?.(new ActionError('browser_unavailable'));
    this.quarantine.get(contents)?.release(); this.quarantine.delete(contents);
    return true;
  }

  execute(request: Request, context: BrowserAgentActionContext): BrowserAgentActionTicket {
    request = captureRequest(request);
    const monotonicDeadline = this.clock.now() + Math.min(10_000, request.deadlineUnixMs - Date.now());
    let deliver: (receipt: BrowserActionReceipt) => void = () => undefined;
    const result = new Promise<BrowserActionReceipt>(resolve => { deliver = resolve; });
    let delivered = false, stopped = false, dispatched = false, actionSource: BrowserActionSource | undefined, contents: BrowserAgentNativeTab['contents'] | undefined;
    const complete = (receipt: BrowserActionReceipt): void => { if (!delivered) { delivered = true; deliver(Object.freeze(receipt)); } };
    const stop = (): void => { stopped = true; complete(failure(context.signal?.reason === 'browser_deadline' ? 'browser_deadline' : 'browser_cancelled', dispatched, actionSource)); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = (async (): Promise<void> => {
      try {
        if (!isBrowserActionTool(request.tool) || !isBrowserToolArguments(request.tool, request.arguments)) throw new ActionError('browser_unavailable');
        if (request.arguments.tabId !== context.fence.registration.tabId) throw new ActionError('browser_stale_ref');
        actionSource = source(context);
        const tab = this.check(context, request.deadlineUnixMs, undefined, monotonicDeadline);
        contents = tab.contents;
        if (this.busy.has(contents)) throw new ActionError('browser_unavailable');
        this.busy.add(contents);
        let releaseIdle: () => void = () => undefined;
        this.idle.set(contents, { settled: new Promise<void>(resolve => { releaseIdle = resolve; }), release: releaseIdle });
        timer = setTimeout(() => { stopped = true; complete(failure('browser_deadline', dispatched, actionSource)); }, Math.max(1, monotonicDeadline - this.clock.now()));
        context.signal?.addEventListener('abort', stop, { once: true });
        this.active.set(contents, { sourceTabId: context.fence.registration.sourceTabId, stop });
        const receipt = await this.session(contents, async nativeCommand => {
          const gate = (): void => {
            this.check(context, request.deadlineUnixMs, contents, monotonicDeadline);
            if (stopped) throw new ActionError('browser_cancelled');
          };
          const baseCommand: NativeCommand = async (method, params) => {
            gate(); const value = await nativeCommand(method, params); gate(); return value;
          };
          const identity = this.identity(await baseCommand('Page.getFrameTree'), context.fence);
          const command: ActionCommand = async (method, params, options) => {
            gate();
            if (mutatesPage(method, params)) {
              const current = this.identity(await baseCommand('Page.getFrameTree'), context.fence);
              if (!sameIdentity(identity, current)) throw new ActionError('browser_stale_ref');
              if (options?.focusObjectId) {
                const focused = object(object(await baseCommand('Runtime.callFunctionOn', { objectId: options.focusObjectId, functionDeclaration: IS_FOCUSED, returnByValue: true, silent: true, userGesture: false })).result).value;
                if (focused !== true) throw new ActionError('browser_action_failed');
              }
            }
            return baseCommand(method, params);
          };
          const navigationUrl = request.tool === 'browser_navigate' ? this.navigationUrl(request.arguments.url) : undefined;
          const navigate = request.tool === 'browser_navigate' ? context.navigate : undefined;
          if (request.tool === 'browser_navigate' && !navigate) throw new ActionError('browser_navigation_rejected');
          const target = request.tool === 'browser_navigate' ? undefined : await this.inspect(command, context, identity, String(request.arguments.ref ?? ''));
          if (target) this.validateTarget(request, target.state);
          this.check(context, request.deadlineUnixMs, contents, monotonicDeadline);
          if (stopped) throw new ActionError('browser_cancelled');
          // An uncertain authenticated dispatch acknowledgment can never be replayed.
          dispatched = true;
          await context.beforeDispatch();
          this.check(context, request.deadlineUnixMs, contents, monotonicDeadline);
          if (stopped) throw new ActionError('browser_cancelled');
          if (request.tool === 'browser_navigate') {
            const url = navigationUrl!;
            const currentIdentity = this.identity(await command('Page.getFrameTree'), context.fence);
            if (!sameIdentity(identity, currentIdentity)) throw new ActionError('browser_stale_ref');
            // The admitted navigation is expected to revoke this exact grant. Do not let
            // that host-owned invalidation overwrite the navigation admission receipt.
            const active = this.active.get(contents!);
            if (active?.stop === stop) active.navigating = true;
            const navigation = await navigate!(url);
            return { outcome: 'completed', source: actionSource!, navigation: { admitted: true, sharingRevoked: navigation.sharingRevoked } } satisfies BrowserActionReceipt;
          }
          const current = await this.inspect(command, context, identity, String(request.arguments.ref ?? ''));
          this.validateTarget(request, current.state);
          this.check(context, request.deadlineUnixMs, contents, monotonicDeadline);
          await this.mutate(command, request, current);
          return { outcome: 'completed', source: actionSource! } satisfies BrowserActionReceipt;
        }, () => complete(failure('browser_outcome_unknown', true, actionSource)));
        if (!isBrowserActionReceipt(receipt)) throw new ActionError('browser_action_failed');
        complete(receipt);
      } catch (error) { complete(failure(errorCode(error), dispatched, actionSource)); }
      finally {
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener('abort', stop);
        if (contents && this.active.get(contents)?.stop === stop) this.active.delete(contents);
        if (contents) { this.busy.delete(contents); this.idle.get(contents)?.release(); this.idle.delete(contents); this.destruction.delete(contents); }
      }
    })();
    return Object.freeze({ result, settled });
  }

  private check(context: BrowserAgentActionContext, deadline: number, contents?: BrowserAgentNativeTab['contents'], monotonicDeadline = Infinity): BrowserAgentNativeTab {
    if (this.capability.electronVersion !== '44.3.0' || !this.capability.available()) throw new ActionError('browser_unavailable');
    if (context.signal?.aborted) throw new ActionError(context.signal.reason === 'browser_deadline' ? 'browser_deadline' : 'browser_cancelled');
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || this.clock.now() >= monotonicDeadline) throw new ActionError('browser_deadline');
    context.assertAuthorized();
    const tab = context.getTab(), document = tab?.document, fence = context.fence;
    if (!tab || !document || tab.contents.isDestroyed() || contents && contents !== tab.contents || !document.available || !document.loaded) throw new ActionError('browser_unavailable');
    if (!sameRegistration(fence.registration, context.fence.registration) || document.sourceTabId !== fence.registration.sourceTabId || document.viewGeneration !== fence.registration.viewGeneration
      || document.documentGeneration !== fence.documentGeneration || document.navigationEpoch !== fence.navigationEpoch || document.url !== fence.url || browserAgentOrigin(document.url) !== fence.origin
      || fence.origin === document.appOrigin || !/^https?:\/\//.test(document.url)) throw new ActionError('browser_stale_ref');
    return tab;
  }

  private identity(value: unknown, fence: BrowserAgentControlFence): NativeIdentity {
    const frame = object(object(value).frameTree).frame, root = object(frame);
    if (typeof root.id !== 'string' || !root.id || typeof root.loaderId !== 'string' || !root.loaderId || root.parentId !== undefined || root.url !== fence.url || root.securityOrigin !== fence.origin) throw new ActionError('browser_stale_ref');
    return { frameId: root.id, loaderId: root.loaderId };
  }

  private async inspect(command: ActionCommand, context: BrowserAgentActionContext, identity: NativeIdentity, ref: string): Promise<{ ref: BrowserAgentNodeRef; objectId: string; state: ElementState; x: number; y: number }> {
    const resolved = context.resolveRef(ref);
    if (resolved.frameId !== identity.frameId) throw new ActionError('browser_stale_ref');
    const described = object(object(await command('DOM.describeNode', { backendNodeId: resolved.backendNodeId, depth: 0, pierce: false })).node);
    if (described.backendNodeId !== resolved.backendNodeId || described.frameId !== undefined && described.frameId !== identity.frameId) throw new ActionError('browser_stale_ref');
    const model = object(await command('DOM.getBoxModel', { backendNodeId: resolved.backendNodeId })).model, quad = object(model).border;
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) throw new ActionError('browser_unavailable');
    const x = (Number(quad[0]) + Number(quad[2]) + Number(quad[4]) + Number(quad[6])) / 4, y = (Number(quad[1]) + Number(quad[3]) + Number(quad[5]) + Number(quad[7])) / 4;
    const hit = object(await command('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }));
    if (hit.backendNodeId !== resolved.backendNodeId || hit.frameId !== identity.frameId) throw new ActionError('browser_unavailable');
    const remote = object(object(await command('DOM.resolveNode', { backendNodeId: resolved.backendNodeId, objectGroup: 'threadterm-browser-action' })).object), objectId = remote.objectId;
    if (typeof objectId !== 'string' || !objectId) throw new ActionError('browser_stale_ref');
    const inspected = object(object(await command('Runtime.callFunctionOn', { objectId, functionDeclaration: INSPECT_ELEMENT, returnByValue: true, silent: true, userGesture: false })).result).value;
    const state = object(inspected) as unknown as ElementState;
    if (state.connected !== true || state.visible !== true || state.disabled !== false || typeof state.readOnly !== 'boolean' || typeof state.tag !== 'string'
      || typeof state.type !== 'string' || typeof state.editable !== 'boolean' || typeof state.focusable !== 'boolean' || typeof state.select !== 'boolean') throw new ActionError('browser_unavailable');
    return { ref: resolved, objectId, state, x, y };
  }

  private async mutate(command: ActionCommand, request: Request, target: { ref: BrowserAgentNodeRef; objectId: string; state: ElementState; x: number; y: number }): Promise<void> {
    switch (request.tool) {
      case 'browser_hover': await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', buttons: 0, modifiers: 0, pointerType: 'mouse' }); return;
      case 'browser_click':
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none', buttons: 0, modifiers: 0, pointerType: 'mouse' });
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 0, pointerType: 'mouse' });
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 0, pointerType: 'mouse' }); return;
      case 'browser_type': {
        if (!target.state.editable || target.state.disabled || target.state.readOnly || target.state.type === 'file') throw new ActionError('browser_unavailable');
        const cleared = object(object(await command('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: CLEAR_EDITABLE, returnByValue: true, silent: true, userGesture: true })).result).value;
        if (cleared !== true) throw new ActionError('browser_action_failed');
        await command('Input.insertText', { text: request.arguments.text }, { focusObjectId: target.objectId }); return;
      }
      case 'browser_press_key': {
        if (!target.state.focusable || target.state.disabled) throw new ActionError('browser_unavailable');
        await command('DOM.focus', { backendNodeId: target.ref.backendNodeId });
        const key = KEY_DATA[request.arguments.key as BrowserPageKey];
        if (!key) throw new ActionError('browser_unavailable');
        await command('Input.dispatchKeyEvent', { type: 'keyDown', ...key, nativeVirtualKeyCode: key.windowsVirtualKeyCode, modifiers: 0 }, { focusObjectId: target.objectId });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', ...key, nativeVirtualKeyCode: key.windowsVirtualKeyCode, modifiers: 0 }); return;
      }
      case 'browser_select_option': {
        if (!target.state.select || target.state.disabled) throw new ActionError('browser_unavailable');
        const selected = object(object(await command('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: SELECT_OPTIONS, arguments: [{ value: request.arguments.values }], returnByValue: true, silent: true, userGesture: true })).result).value;
        if (selected !== true) throw new ActionError('browser_action_failed'); return;
      }
      default: throw new ActionError('browser_unavailable');
    }
  }

  private validateTarget(request: Request, state: ElementState): void {
    if (request.tool === 'browser_type' && (!state.editable || state.disabled || state.readOnly || state.type === 'file')) throw new ActionError('browser_unavailable');
    if (request.tool === 'browser_press_key' && (!state.focusable || state.disabled)) throw new ActionError('browser_unavailable');
    if (request.tool === 'browser_select_option' && (!state.select || state.disabled)) throw new ActionError('browser_unavailable');
  }

  private navigationUrl(value: unknown): string {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8192) throw new ActionError('browser_navigation_rejected');
    try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); return url.href; }
    catch { throw new ActionError('browser_navigation_rejected'); }
  }

  private async session<T>(contents: BrowserAgentNativeTab['contents'], run: (command: (method: string, params?: JsonObject) => Promise<unknown>) => Promise<T>, uncertain: () => void): Promise<T> {
    const client = contents.debugger;
    if (client.isAttached() || contents.isDestroyed()) throw new ActionError('browser_unavailable');
    let owned = false, detached = false, issuedMutation = false, rejectDestroyed: (error: Error) => void = () => undefined;
    const destroyed = new Promise<never>((_resolve, reject) => { rejectDestroyed = reject; }); void destroyed.catch(() => undefined);
    this.destruction.set(contents, rejectDestroyed);
    const quarantine = (): void => {
      if (!this.quarantine.has(contents)) {
        let release: () => void = () => undefined;
        this.quarantine.set(contents, { settled: new Promise<void>(resolve => { release = resolve; }), release: () => release() });
      }
      uncertain();
    };
    const onDetach = (): void => {
      const unexpectedlyOwned = owned;
      detached = true; owned = false;
      if (unexpectedlyOwned && issuedMutation) quarantine();
    };
    const command = async (method: string, params?: JsonObject): Promise<unknown> => {
      if (!owned || detached || !client.isAttached() || contents.isDestroyed()) throw new ActionError('browser_unavailable');
      if (method === 'Input.dispatchMouseEvent' || method === 'Input.insertText' || method === 'Input.dispatchKeyEvent' || method === 'DOM.focus'
        || method === 'Runtime.callFunctionOn' && (params?.functionDeclaration === CLEAR_EDITABLE || params?.functionDeclaration === SELECT_OPTIONS)) issuedMutation = true;
      try { return await Promise.race([client.sendCommand(method, params), destroyed]); }
      catch (error) { if (issuedMutation && !contents.isDestroyed()) uncertain(); throw error; }
    };
    client.on('detach', onDetach);
    try {
      client.attach('1.3');
      if (detached || !client.isAttached()) throw new ActionError('browser_unavailable');
      owned = true;
      return await run(command);
    } finally {
      try {
        if (owned && client.isAttached()) {
          try { await client.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'threadterm-browser-action' }); } catch { /* Navigation/detach may have destroyed the group. */ }
          owned = false; client.detach();
        }
      } finally {
        client.removeListener('detach', onDetach);
        if (this.quarantine.has(contents)) {
          if (contents.isDestroyed()) this.confirmDestroyed(contents);
          await this.quarantine.get(contents)?.settled;
        }
      }
    }
  }
}
