import { randomBytes } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  BrowserWindow,
  CustomScheme,
  Event,
  HandlerDetails,
  OnBeforeRequestListenerDetails,
  Session,
  WebContentsWillFrameNavigateEventParams,
  WebContentsWillRedirectEventParams,
  WebFrameMain,
} from 'electron';
export { HTML_PREVIEW_RTC_POLICY_CHANNEL } from './htmlPreviewPolicy.js';

export const HTML_PREVIEW_SCHEME = 'tt-preview';
export const HTML_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
export const HTML_PREVIEW_DEFAULT_CAPACITY = 64;

const GRANT_ID = /^[a-f0-9]{32}$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const TEXT_MIME = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.map']);
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.txt': 'text/plain', '.map': 'application/json',
});

export interface HtmlPreviewGrant {
  id: string;
  url: string;
  rootRealPath: string;
  entryPath: string;
  ownerWebContentsId: number;
  frameName: string;
  remoteContentAllowed: boolean;
  frameTreeNodeId?: number;
  rendererProcessId?: number;
  rendererOsProcessId?: number;
}

export interface HtmlPreviewGrantInput {
  rootPath: string;
  entryPath: string;
  ownerWebContentsId: number;
  frameName: string;
  remoteContentAllowed?: boolean;
}

export interface HtmlPreviewResolvedFile {
  grant: HtmlPreviewGrant;
  path: string;
  size: number;
  mimeType: string;
}

export interface HtmlPreviewGrantManagerOptions {
  capacity?: number;
  randomId?: () => string;
}

export interface HtmlPreviewRequestDecisionInput {
  targetUrl: string;
  sourceGrantId?: string;
  remoteContentAllowed?: boolean;
  ambiguousPreviewOwner?: boolean;
}

export type HtmlPreviewRequestDecision =
  | { allow: true; reason: 'not-preview' | 'same-grant' | 'inline-resource' | 'remote-https' }
  | { allow: false; reason: 'unknown-source' | 'cross-grant' | 'network-blocked' | 'scheme-blocked' };

class PreviewRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function cloneGrant(grant: HtmlPreviewGrant): HtmlPreviewGrant { return { ...grant }; }

function validFrameName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function encodedPreviewPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function rawUrlPath(value: string): { id: string; rawPath: string } | undefined {
  const match = /^tt-preview:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(value);
  if (!match || !GRANT_ID.test(match[1]!.toLowerCase())) return undefined;
  return { id: match[1]!.toLowerCase(), rawPath: match[2] ?? '/' };
}

function isOpaqueDocumentUrl(value: string): boolean {
  return !value || value === 'null' || value === 'about:blank' || value === 'about:srcdoc'
    || value.startsWith('blob:') || value.startsWith('data:');
}

/** Validate a literal root-relative filesystem path. URL percent-decoding happens separately and exactly once. */
export function normalizePreviewPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new Error('Invalid preview path');
  if (value.startsWith('/') || isAbsolute(value) || /^[a-z]:/i.test(value)
    || value.startsWith('\\\\') || value.startsWith('\\?\\') || value.includes('\\')
    || value.includes(':') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid preview path');
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..'
    || segment.endsWith('.') || segment.endsWith(' ') || DEVICE_NAME.test(segment))) throw new Error('Invalid preview path');
  return segments.join('/');
}

/** Native canonical containment; equality is allowed for callers that validate file-vs-directory separately. */
export function isPathContained(root: string, candidate: string): boolean {
  const part = relative(resolve(root), resolve(candidate));
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

export function mimeTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const type = MIME_TYPES[extension] ?? 'application/octet-stream';
  return TEXT_MIME.has(extension) ? `${type}; charset=utf-8` : type;
}

export function parsePreviewUrl(value: string): { grantId: string; path: string } | undefined {
  const parsed = rawUrlPath(value);
  if (!parsed || !parsed.rawPath.startsWith('/') || parsed.rawPath.startsWith('//')) return undefined;
  try {
    const decoded = decodeURIComponent(parsed.rawPath.slice(1));
    return { grantId: parsed.id, path: normalizePreviewPath(decoded) };
  } catch { return undefined; }
}

function cspAncestor(value: string): string {
  if (value === 'file:') return value;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value) return value;
  } catch { /* fail closed below */ }
  return "'none'";
}

/** CSP is grant-host-specific, so a page cannot load another live grant even though both use the same scheme. */
export function buildPreviewCsp(grantId: string, appFrameAncestor: string, remoteContentAllowed = false): string {
  if (!GRANT_ID.test(grantId)) throw new Error('Invalid preview grant');
  const own = `${HTML_PREVIEW_SCHEME}://${grantId}`;
  const remote = remoteContentAllowed ? ' https:' : '';
  return [
    "default-src 'none'",
    `script-src ${own} 'unsafe-inline' 'unsafe-eval' blob: data:${remote}`,
    `style-src ${own} 'unsafe-inline' data:${remote}`,
    `img-src ${own} data: blob:${remote}`,
    `font-src ${own} data:${remote}`,
    `media-src ${own} data: blob:${remote}`,
    `connect-src ${own}${remote}`,
    `worker-src blob: ${own}`,
    `frame-src ${own}`,
    `form-action ${own}`,
    `base-uri ${own}`,
    "object-src 'none'",
    `frame-ancestors ${cspAncestor(appFrameAncestor)} ${own}`,
  ].join('; ');
}

export function decidePreviewRequest(input: HtmlPreviewRequestDecisionInput): HtmlPreviewRequestDecision {
  if (!input.sourceGrantId && !input.ambiguousPreviewOwner) return { allow: true, reason: 'not-preview' };
  if (!input.sourceGrantId) return { allow: false, reason: 'unknown-source' };
  const target = rawUrlPath(input.targetUrl);
  if (target) return target.id === input.sourceGrantId
    ? { allow: true, reason: 'same-grant' }
    : { allow: false, reason: 'cross-grant' };
  let protocolName: string;
  try { protocolName = new URL(input.targetUrl).protocol; } catch { return { allow: false, reason: 'scheme-blocked' }; }
  if (protocolName === 'blob:' || protocolName === 'data:') return { allow: true, reason: 'inline-resource' };
  if (protocolName === 'https:' && input.remoteContentAllowed) return { allow: true, reason: 'remote-https' };
  if (protocolName === 'http:' || protocolName === 'https:' || protocolName === 'ws:' || protocolName === 'wss:') {
    return { allow: false, reason: 'network-blocked' };
  }
  return { allow: false, reason: 'scheme-blocked' };
}

export function mergePreviewIsolationFeatures(existing: string): string {
  const features = existing.split(',').map(value => value.trim()).filter(Boolean);
  if (!features.some(value => value.split('<', 1)[0] === 'IsolateSandboxedIframes')) features.push('IsolateSandboxedIframes');
  return features.join(',');
}

export function previewProcessIsolation(appOsProcessId: number, previewOsProcessId: number): { isolated: boolean; appOsProcessId: number; previewOsProcessId: number } {
  return { isolated: appOsProcessId > 0 && previewOsProcessId > 0 && appOsProcessId !== previewOsProcessId, appOsProcessId, previewOsProcessId };
}

export function shouldDisableHtmlPreviewWebRtc(frame: WebFrameMain | null | undefined, ownerWebContentsId: number, manager: HtmlPreviewGrantManager): boolean {
  const seen = new Set<number>();
  for (let current = frame; current && !seen.has(current.frameTreeNodeId); current = current.parent) {
    seen.add(current.frameTreeNodeId);
    if (rawUrlPath(current.url)) return true;
  }
  if (!frame?.parent || frame.top?.frameTreeNodeId !== frame.parent.frameTreeNodeId) return false;
  return manager.listForOwner(ownerWebContentsId).some(grant => grant.frameName === frame.name && grant.frameTreeNodeId === undefined);
}

/** Registered by main.ts together with every other privileged scheme: Electron keeps only the last
 * `registerSchemesAsPrivileged` call, so a second call would strip these privileges (fetch() in previews fails). */
export const HTML_PREVIEW_PRIVILEGED_SCHEME: CustomScheme = {
  scheme: HTML_PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

export class HtmlPreviewGrantManager {
  readonly capacity: number;
  private readonly grants = new Map<string, HtmlPreviewGrant>();
  private readonly retiredOwners = new Set<number>();
  private readonly randomId: () => string;
  private readonly revokeListeners = new Set<(grant: HtmlPreviewGrant) => void>();

  constructor(options: HtmlPreviewGrantManagerOptions = {}) {
    this.capacity = options.capacity ?? HTML_PREVIEW_DEFAULT_CAPACITY;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 4096) throw new Error('Invalid preview grant capacity');
    this.randomId = options.randomId ?? (() => randomBytes(16).toString('hex'));
  }

  async create(input: HtmlPreviewGrantInput): Promise<HtmlPreviewGrant> {
    if (!Number.isSafeInteger(input.ownerWebContentsId) || input.ownerWebContentsId < 1 || !validFrameName(input.frameName)) throw new Error('Invalid preview owner');
    const entryPath = normalizePreviewPath(input.entryPath);
    const rootRealPath = await realpath(input.rootPath);
    if (!(await stat(rootRealPath)).isDirectory()) throw new Error('Preview root is not a directory');
    await this.resolvePath(rootRealPath, entryPath);
    let id = '';
    for (let attempts = 0; attempts < 8 && !id; attempts += 1) {
      const candidate = this.randomId();
      if (!GRANT_ID.test(candidate)) throw new Error('Preview grant ids must contain 128 random bits');
      if (!this.grants.has(candidate)) id = candidate;
    }
    if (!id) throw new Error('Could not allocate a preview grant');
    const grant: HtmlPreviewGrant = {
      id, rootRealPath, entryPath, ownerWebContentsId: input.ownerWebContentsId,
      frameName: input.frameName, remoteContentAllowed: input.remoteContentAllowed === true,
      url: `${HTML_PREVIEW_SCHEME}://${id}/${encodedPreviewPath(entryPath)}`,
    };
    this.grants.set(id, grant);
    while (this.grants.size > this.capacity) this.revoke(this.grants.keys().next().value!);
    return cloneGrant(grant);
  }

  get(id: string): HtmlPreviewGrant | undefined {
    const grant = this.grants.get(id);
    return grant ? cloneGrant(grant) : undefined;
  }

  listForOwner(ownerWebContentsId: number): HtmlPreviewGrant[] {
    return [...this.grants.values()].filter(grant => grant.ownerWebContentsId === ownerWebContentsId).map(cloneGrant);
  }

  hasAny(): boolean { return this.grants.size > 0; }

  /** Keep opaque, frameless requests fail closed after a grant disappears and until its WebContents is destroyed. */
  hasOwnerSecurityContext(ownerWebContentsId: number): boolean {
    return this.retiredOwners.has(ownerWebContentsId)
      || [...this.grants.values()].some(grant => grant.ownerWebContentsId === ownerWebContentsId);
  }

  hasRetiredOwner(ownerWebContentsId: number): boolean { return this.retiredOwners.has(ownerWebContentsId); }

  hasAnySecurityContext(): boolean { return this.grants.size > 0 || this.retiredOwners.size > 0; }

  setRemoteContentAllowed(id: string, allowed: boolean): HtmlPreviewGrant {
    const grant = this.touch(id);
    if (!grant) throw new Error('Unknown preview grant');
    grant.remoteContentAllowed = allowed;
    return cloneGrant(grant);
  }

  bindFrame(id: string, ownerWebContentsId: number, frameName: string, frameTreeNodeId: number, rendererProcessId: number, rendererOsProcessId: number): HtmlPreviewGrant {
    const grant = this.touch(id);
    if (!grant || grant.ownerWebContentsId !== ownerWebContentsId || grant.frameName !== frameName
      || !Number.isSafeInteger(frameTreeNodeId) || frameTreeNodeId < 0) throw new Error('Preview frame does not own this grant');
    if (grant.frameTreeNodeId !== undefined && grant.frameTreeNodeId !== frameTreeNodeId) throw new Error('Preview grant is already bound to another frame');
    grant.frameTreeNodeId = frameTreeNodeId;
    grant.rendererProcessId = rendererProcessId;
    grant.rendererOsProcessId = rendererOsProcessId;
    return cloneGrant(grant);
  }

  revoke(id: string): boolean {
    const grant = this.grants.get(id);
    if (!grant) return false;
    this.retiredOwners.add(grant.ownerWebContentsId);
    this.grants.delete(id);
    const snapshot = cloneGrant(grant);
    for (const listener of this.revokeListeners) listener(snapshot);
    return true;
  }

  revokeOwner(ownerWebContentsId: number): void {
    for (const grant of [...this.grants.values()]) if (grant.ownerWebContentsId === ownerWebContentsId) this.revoke(grant.id);
  }

  releaseOwner(ownerWebContentsId: number): void {
    this.revokeOwner(ownerWebContentsId);
    this.retiredOwners.delete(ownerWebContentsId);
  }

  revokeFrame(ownerWebContentsId: number, frameTreeNodeId: number): void {
    for (const grant of [...this.grants.values()]) if (grant.ownerWebContentsId === ownerWebContentsId && grant.frameTreeNodeId === frameTreeNodeId) this.revoke(grant.id);
  }

  onRevoke(listener: (grant: HtmlPreviewGrant) => void): () => void {
    this.revokeListeners.add(listener);
    return () => { this.revokeListeners.delete(listener); };
  }

  grantForProcess(ownerWebContentsId: number, rendererProcessId: number): HtmlPreviewGrant | undefined {
    if (!Number.isSafeInteger(rendererProcessId) || rendererProcessId < 1) return undefined;
    const matches = [...this.grants.values()].filter(grant => grant.ownerWebContentsId === ownerWebContentsId && grant.rendererProcessId === rendererProcessId);
    return matches.length === 1 ? cloneGrant(matches[0]!) : undefined;
  }

  async resolve(url: string): Promise<HtmlPreviewResolvedFile> {
    const parsed = parsePreviewUrl(url);
    if (!parsed) throw new PreviewRequestError(404, 'Preview not found');
    const grant = this.touch(parsed.grantId);
    if (!grant) throw new PreviewRequestError(404, 'Preview not found');
    const target = await this.resolvePath(grant.rootRealPath, parsed.path);
    return { grant: cloneGrant(grant), path: target.path, size: target.size, mimeType: mimeTypeForPath(target.path) };
  }

  private touch(id: string): HtmlPreviewGrant | undefined {
    const grant = this.grants.get(id);
    if (!grant) return undefined;
    this.grants.delete(id);
    this.grants.set(id, grant);
    return grant;
  }

  private async resolvePath(rootRealPath: string, path: string): Promise<{ path: string; size: number }> {
    const normalized = normalizePreviewPath(path);
    try {
      const currentRoot = await realpath(rootRealPath);
      if (!isPathContained(rootRealPath, currentRoot) || !isPathContained(currentRoot, rootRealPath)) throw new PreviewRequestError(404, 'Preview root changed');
      const target = await realpath(join(currentRoot, ...normalized.split('/')));
      if (!isPathContained(currentRoot, target) || target === currentRoot) throw new PreviewRequestError(404, 'Preview path escaped its root');
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new PreviewRequestError(404, 'Preview path is not a regular file');
      if (metadata.size > HTML_PREVIEW_MAX_BYTES) throw new PreviewRequestError(413, 'Preview file is too large');
      return { path: target, size: metadata.size };
    } catch (error) {
      if (error instanceof PreviewRequestError) throw error;
      throw new PreviewRequestError(404, 'Preview not found');
    }
  }
}

function previewGrantFromFrame(frame: WebFrameMain | null | undefined): string | undefined {
  const seen = new Set<number>();
  for (let current = frame; current && !seen.has(current.frameTreeNodeId); current = current.parent) {
    seen.add(current.frameTreeNodeId);
    const parsed = rawUrlPath(current.url);
    if (parsed) return parsed.id;
  }
  return undefined;
}

function frameForIds(window: BrowserWindow, processId: number, routingId: number): WebFrameMain | undefined {
  return window.webContents.mainFrame.framesInSubtree.find(frame => frame.processId === processId && frame.routingId === routingId);
}

function responseHeaders(file: HtmlPreviewResolvedFile, appFrameAncestor: string): Headers {
  const headers = new Headers({
    'Content-Type': file.mimeType,
    'Content-Length': String(file.size),
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'null',
    'Vary': 'Origin',
  });
  if (/^text\/html(?:;|$)/.test(file.mimeType)) headers.set('Content-Security-Policy', buildPreviewCsp(file.grant.id, appFrameAncestor, file.grant.remoteContentAllowed));
  return headers;
}

async function readExactPreviewFile(file: HtmlPreviewResolvedFile): Promise<ArrayBuffer> {
  const handle = await open(file.path, 'r');
  try {
    const validateIdentity = async () => {
      const [opened, currentPath, currentRoot] = await Promise.all([
        handle.stat({ bigint: true }), realpath(file.path), realpath(file.grant.rootRealPath),
      ]);
      if (!isPathContained(file.grant.rootRealPath, currentRoot) || !isPathContained(currentRoot, file.grant.rootRealPath)
        || !isPathContained(currentRoot, currentPath)) throw new PreviewRequestError(404, 'Preview file escaped its root');
      const current = await stat(currentPath, { bigint: true });
      if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
        || opened.size !== BigInt(file.size) || current.size !== BigInt(file.size)
        || opened.size > BigInt(HTML_PREVIEW_MAX_BYTES)) throw new PreviewRequestError(404, 'Preview file changed');
    };
    await validateIdentity();
    const bytes = new Uint8Array(file.size);
    let offset = 0;
    while (offset < file.size) {
      const { bytesRead } = await handle.read(bytes, offset, file.size - offset, offset);
      if (!bytesRead) throw new PreviewRequestError(404, 'Preview file changed');
      offset += bytesRead;
    }
    const probe = new Uint8Array(1);
    const extra = await handle.read(probe, 0, 1, file.size);
    if (extra.bytesRead) throw new PreviewRequestError(404, 'Preview file changed');
    await validateIdentity();
    return bytes.buffer as ArrayBuffer;
  } finally { await handle.close(); }
}

async function protocolResponse(request: Request, manager: HtmlPreviewGrantManager, appFrameAncestor: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-DNS-Prefetch-Control': 'off' } });
  try {
    const file = await manager.resolve(request.url);
    if (request.method === 'HEAD') {
      const active = manager.get(file.grant.id);
      if (!active) throw new PreviewRequestError(404, 'Preview grant was revoked');
      return new Response(null, { status: 200, headers: responseHeaders({ ...file, grant: active }, appFrameAncestor) });
    }
    const body = await readExactPreviewFile(file);
    const active = manager.get(file.grant.id);
    if (!active) throw new PreviewRequestError(404, 'Preview grant was revoked');
    return new Response(body, { status: 200, headers: responseHeaders({ ...file, grant: active }, appFrameAncestor) });
  } catch (error) {
    const status = error instanceof PreviewRequestError ? error.status : 404;
    return new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-DNS-Prefetch-Control': 'off' } });
  }
}

export function installHtmlPreviewSession(sessionApi: Session, manager: HtmlPreviewGrantManager, options: { appFrameAncestor: string }): void {
  sessionApi.protocol.handle(HTML_PREVIEW_SCHEME, request => protocolResponse(request, manager, options.appFrameAncestor));
  sessionApi.webRequest.onBeforeRequest((details: OnBeforeRequestListenerDetails, callback) => {
    const ownerId = details.webContentsId;
    const fromFrame = previewGrantFromFrame(details.frame);
    const fromReferrer = rawUrlPath(details.referrer)?.id;
    const fromProcess = ownerId && details.frame ? manager.grantForProcess(ownerId, details.frame.processId)?.id : undefined;
    const sourceGrantId = fromFrame ?? fromReferrer ?? fromProcess;
    const target = rawUrlPath(details.url);
    if (!sourceGrantId && target) {
      const grant = manager.get(target.id);
      if (!grant) {
        callback({ cancel: false });
        return;
      }
      const parent = details.frame?.parent;
      const mainFrame = details.webContents?.mainFrame;
      const directAppChild = Boolean(parent && mainFrame && parent.frameTreeNodeId === mainFrame.frameTreeNodeId);
      const initialFrameNavigation = Boolean(grant && ownerId !== undefined && grant.ownerWebContentsId === ownerId
        && grant.frameTreeNodeId === undefined && details.resourceType === 'subFrame' && details.method === 'GET'
        && details.frame?.name === grant.frameName && directAppChild);
      callback({ cancel: !initialFrameNavigation });
      return;
    }
    const source = sourceGrantId ? manager.get(sourceGrantId) : undefined;
    const ownerGrants = ownerId === undefined ? [] : manager.listForOwner(ownerId);
    const opaqueReferrer = isOpaqueDocumentUrl(details.referrer);
    const ambiguous = !sourceGrantId && !details.frame && opaqueReferrer
      && (ownerId === undefined ? manager.hasAnySecurityContext() : manager.hasOwnerSecurityContext(ownerId));
    const inferred = source ?? (ambiguous && ownerId !== undefined && ownerGrants.length === 1
      && !manager.hasRetiredOwner(ownerId) ? ownerGrants[0] : undefined);
    const decision = decidePreviewRequest({
      targetUrl: details.url,
      sourceGrantId: inferred?.id ?? sourceGrantId,
      remoteContentAllowed: inferred?.remoteContentAllowed,
      ambiguousPreviewOwner: ambiguous,
    });
    callback({ cancel: !decision.allow });
  });
  sessionApi.setPermissionRequestHandler((contents, _permission, callback, details) => {
    const ownerHasPreview = manager.hasOwnerSecurityContext(contents.id);
    const requestingUrl = details.requestingUrl;
    const preview = Boolean(rawUrlPath(requestingUrl)) || ownerHasPreview && isOpaqueDocumentUrl(requestingUrl);
    callback(!preview);
  });
  sessionApi.setPermissionCheckHandler((contents, _permission, origin, details) => {
    const ownerHasPreview = contents ? manager.hasOwnerSecurityContext(contents.id) : false;
    const requestingUrl = details.requestingUrl ?? '';
    const securityOrigin = details.securityOrigin ?? origin;
    const opaqueDocument = isOpaqueDocumentUrl(requestingUrl);
    const opaquePreview = ownerHasPreview && opaqueDocument && securityOrigin === 'null';
    return !(Boolean(rawUrlPath(requestingUrl)) || Boolean(rawUrlPath(securityOrigin)) || opaquePreview
      || !contents && securityOrigin === 'null' && manager.hasAnySecurityContext());
  });
  sessionApi.on('will-download', (event, item, contents) => {
    const url = item.getURL();
    const opaque = url.startsWith('blob:') || url.startsWith('data:');
    const ownerGrants = manager.listForOwner(contents.id);
    const hasBoundPreview = ownerGrants.some(grant => grant.frameTreeNodeId !== undefined);
    if (rawUrlPath(url) || opaque && ownerGrants.length > 0 || hasBoundPreview
      || manager.hasRetiredOwner(contents.id)) event.preventDefault();
  });
}

function externalLink(value: string): boolean {
  try { const protocolName = new URL(value).protocol; return protocolName === 'http:' || protocolName === 'https:'; } catch { return false; }
}

export function attachHtmlPreviewWindow(window: BrowserWindow, manager: HtmlPreviewGrantManager, options: { forwardLink: (frameName: string, url: string, grantId: string) => void }): void {
  const contents = window.webContents;
  const ownerId = contents.id;
  const frames = new Map<string, WebFrameMain>();
  const terminateFrame = (frame: WebFrameMain | undefined) => {
    if (!frame) return;
    if (frame.isDestroyed()) return;
    void frame.executeJavaScript('location.replace("about:blank")').catch(() => {
      if (!frame.isDestroyed()) void frame.executeJavaScript('window.stop();document.documentElement.replaceChildren()').catch(() => undefined);
    });
  };
  const stopRevocation = manager.onRevoke(grant => {
    if (grant.ownerWebContentsId !== ownerId) return;
    const frame = frames.get(grant.id) ?? contents.mainFrame.framesInSubtree.find(candidate => rawUrlPath(candidate.url)?.id === grant.id);
    frames.delete(grant.id);
    const frameName = JSON.stringify(grant.frameName), prefix = JSON.stringify(`${HTML_PREVIEW_SCHEME}://${grant.id}/`);
    if (!contents.mainFrame.isDestroyed()) void contents.mainFrame.executeJavaScript(`(()=>{const n=${frameName},p=${prefix};for(const f of document.querySelectorAll('iframe'))if(f.name===n&&f.src.startsWith(p))f.src='about:blank'})()`).catch(() => terminateFrame(frame));
    else terminateFrame(frame);
  });
  const sourceForNavigation = (details: Event<WebContentsWillFrameNavigateEventParams | WebContentsWillRedirectEventParams>) =>
    previewGrantFromFrame(details.initiator) ?? previewGrantFromFrame(details.frame);
  const guardNavigation = (details: Event<WebContentsWillFrameNavigateEventParams | WebContentsWillRedirectEventParams>) => {
    const sourceId = sourceForNavigation(details);
    if (!sourceId) return;
    const source = manager.get(sourceId);
    const target = rawUrlPath(details.url);
    if (source && target?.id === sourceId) return;
    if (!source && details.url === 'about:blank' && !manager.get(sourceId)) return;
    details.preventDefault();
    if (source && externalLink(details.url)) options.forwardLink(source.frameName, details.url, source.id);
  };
  contents.on('will-frame-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  window.on('close', () => manager.revokeOwner(ownerId));
  contents.setWindowOpenHandler((details: HandlerDetails) => {
    const sourceId = rawUrlPath(details.referrer.url)?.id;
    const bound = sourceId ? [] : manager.listForOwner(ownerId).filter(grant => grant.frameTreeNodeId !== undefined);
    const source = sourceId ? manager.get(sourceId) : bound.length === 1 ? bound[0] : undefined;
    if (source && source.ownerWebContentsId === ownerId && externalLink(details.url)) options.forwardLink(source.frameName, details.url, source.id);
    return { action: 'deny' };
  });
  contents.on('did-frame-navigate', (_event, url, _code, _status, _isMain, processId, routingId) => {
    const navigatedFrame = frameForIds(window, processId, routingId);
    if (url === 'about:blank') return;
    const target = rawUrlPath(url);
    if (!target) return;
    const frame = navigatedFrame;
    if (!frame) { manager.revoke(target.id); return; }
    try {
      const grant = manager.bindFrame(target.id, ownerId, frame.name, frame.frameTreeNodeId, frame.processId, frame.osProcessId);
      frames.set(grant.id, frame);
      if (!previewProcessIsolation(contents.mainFrame.osProcessId, frame.osProcessId).isolated) {
        manager.revoke(grant.id);
        return;
      }
    } catch { terminateFrame(frame); manager.revoke(target.id); }
  });
  contents.on('render-process-gone', () => manager.revokeOwner(ownerId));
  contents.once('destroyed', () => { stopRevocation(); manager.releaseOwner(ownerId); frames.clear(); });
}
