import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserWindow, HandlerDetails, Session, WebFrameMain } from 'electron';
import {
  HTML_PREVIEW_MAX_BYTES,
  HtmlPreviewGrantManager,
  attachHtmlPreviewWindow,
  buildPreviewCsp,
  decidePreviewRequest,
  installHtmlPreviewSession,
  isPathContained,
  mergePreviewIsolationFeatures,
  mimeTypeForPath,
  normalizePreviewPath,
  parsePreviewUrl,
  previewProcessIsolation,
  shouldDisableHtmlPreviewWebRtc,
  HTML_PREVIEW_PRIVILEGED_SCHEME,
} from './htmlPreview.js';

function ids() {
  let value = 0;
  return () => (++value).toString(16).padStart(32, '0');
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'threadterm-html-preview-'));
  const root = join(directory, 'root');
  const outside = join(directory, 'outside');
  await mkdir(join(root, 'site'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'site', 'index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(join(root, 'site', 'data.json'), '{"ok":true}');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  return { directory, root, outside, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('literal preview paths reject traversal, absolute/device/ADS forms but preserve percent filenames', () => {
  for (const value of [
    '', '.', '..', '../secret', 'a/../secret', '/absolute', 'C:/Windows/system.ini', '\\\\server\\share',
    '\\?\\C:\\Windows', 'folder\\file.html', 'name:stream', 'a//b', 'a/./b', 'trailing. ',
    'CON', 'nul.txt', 'COM1.js', 'LPT9', 'CONIN$', 'conout$.txt', 'COM¹', 'LPT³.log', 'bad\0name',
  ]) assert.throws(() => normalizePreviewPath(value), value);
  assert.equal(normalizePreviewPath('site/100% done.html'), 'site/100% done.html');
  assert.equal(normalizePreviewPath('site/%2e%2e.html'), 'site/%2e%2e.html');
  assert.equal(normalizePreviewPath('网站/首页.html'), '网站/首页.html');
});

test('preview URLs decode exactly once and retain raw traversal evidence', () => {
  const id = '1'.repeat(32);
  assert.deepEqual(parsePreviewUrl(`tt-preview://${id}/site/100%25%20done.html?reload=2`), { grantId: id, path: 'site/100% done.html' });
  assert.deepEqual(parsePreviewUrl(`tt-preview://${id}/site/%252e%252e.html`), { grantId: id, path: 'site/%2e%2e.html' });
  for (const value of [
    `tt-preview://${id}/../secret`, `tt-preview://${id}/%2e%2e/secret`,
    `tt-preview://${id}/site/%2fsecret`, `tt-preview://${id}//server/file`,
    `tt-preview://${id}/site/%5csecret`, `tt-preview://${id}/site/%ZZ`,
  ]) assert.equal(parsePreviewUrl(value), undefined, value);
});

test('canonical containment rejects sibling prefixes', () => {
  const root = join(tmpdir(), 'preview-root');
  assert.equal(isPathContained(root, join(root, 'site', 'index.html')), true);
  assert.equal(isPathContained(root, `${root}-other`), false);
  assert.equal(isPathContained(root, join(root, '..', 'secret')), false);
});

test('grant resolution serves regular in-root files and blocks a junction escape', async () => {
  const item = await fixture();
  try {
    const link = join(item.root, 'site', 'escape');
    await symlink(item.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const manager = new HtmlPreviewGrantManager({ randomId: ids() });
    const grant = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 7, frameName: 'tt-preview-frame-1' });
    assert.equal((await manager.resolve(grant.url)).size, Buffer.byteLength('<!doctype html><title>fixture</title>'));
    await assert.rejects(manager.resolve(`tt-preview://${grant.id}/site/escape/secret.txt`), /escaped|not found/i);
    await assert.rejects(manager.create({ rootPath: item.root, entryPath: 'site', ownerWebContentsId: 7, frameName: 'tt-preview-frame-2' }), /regular file/i);
  } finally { await item.cleanup(); }
});

test('literal percent filenames survive grant URL encoding and URL decoding', async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, 'site', '100% done.html'), 'percent');
    await writeFile(join(item.root, 'site', '%2e%2e.html'), 'encoded dots');
    const manager = new HtmlPreviewGrantManager({ randomId: ids() });
    const percent = await manager.create({ rootPath: item.root, entryPath: 'site/100% done.html', ownerWebContentsId: 1, frameName: 'tt-preview-a' });
    const dots = await manager.create({ rootPath: item.root, entryPath: 'site/%2e%2e.html', ownerWebContentsId: 1, frameName: 'tt-preview-b' });
    assert.match(percent.url, /100%25%20done\.html$/);
    assert.match(dots.url, /%252e%252e\.html$/);
    assert.equal((await manager.resolve(percent.url)).path, join(item.root, 'site', '100% done.html'));
    assert.equal((await manager.resolve(dots.url)).path, join(item.root, 'site', '%2e%2e.html'));
  } finally { await item.cleanup(); }
});

test('grants require 128-bit ids and enforce the 25 MiB regular-file limit', async () => {
  const item = await fixture();
  try {
    const weak = new HtmlPreviewGrantManager({ randomId: () => 'a'.repeat(31) });
    await assert.rejects(weak.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 1, frameName: 'tt-preview-a' }), /128 random bits/);
    const large = join(item.root, 'site', 'large.bin');
    await writeFile(large, 'x');
    await truncate(large, HTML_PREVIEW_MAX_BYTES + 1);
    const manager = new HtmlPreviewGrantManager({ randomId: ids() });
    await assert.rejects(manager.create({ rootPath: item.root, entryPath: 'site/large.bin', ownerWebContentsId: 1, frameName: 'tt-preview-b' }), /too large/);
  } finally { await item.cleanup(); }
});

test('grant LRU, remote flag, frame lifetime and owner lifetime are bounded', async () => {
  const item = await fixture();
  try {
    const manager = new HtmlPreviewGrantManager({ capacity: 2, randomId: ids() });
    const revoked: string[] = [];
    manager.onRevoke(grant => revoked.push(grant.id));
    const a = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 1, frameName: 'tt-preview-a' });
    const b = await manager.create({ rootPath: item.root, entryPath: 'site/data.json', ownerWebContentsId: 1, frameName: 'tt-preview-b' });
    await manager.resolve(a.url);
    const c = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 2, frameName: 'tt-preview-c' });
    assert.equal(manager.get(b.id), undefined, 'least recently used grant was evicted');
    assert.deepEqual(revoked, [b.id]);
    assert.equal(manager.setRemoteContentAllowed(a.id, true).remoteContentAllowed, true);
    manager.bindFrame(a.id, 1, 'tt-preview-a', 101, 201, 301);
    assert.throws(() => manager.bindFrame(a.id, 1, 'tt-preview-a', 102, 202, 302), /another frame/);
    manager.revokeFrame(1, 101);
    assert.equal(manager.get(a.id), undefined);
    manager.revokeOwner(2);
    assert.equal(manager.get(c.id), undefined);
    assert.equal(manager.hasOwnerSecurityContext(1), true);
    assert.equal(manager.hasOwnerSecurityContext(2), true);
    manager.releaseOwner(1);
    assert.equal(manager.hasAnySecurityContext(), true, 'releasing one owner does not retire another owner security context');
    manager.releaseOwner(2);
    assert.equal(manager.hasAnySecurityContext(), false);
  } finally { await item.cleanup(); }
});

test('a no-referrer popup is proposed only for one unambiguous bound preview', async () => {
  const item = await fixture();
  try {
    const manager = new HtmlPreviewGrantManager({ randomId: ids() });
    const first = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 9, frameName: 'tt-preview-a' });
    manager.bindFrame(first.id, 9, first.frameName, 11, 21, 31);
    let popup: ((details: HandlerDetails) => { action: 'deny' }) | undefined;
    let closeWindow: (() => void) | undefined;
    const mainFrame = { framesInSubtree: [], osProcessId: 1, isDestroyed: () => false, executeJavaScript: async () => undefined };
    const contents = {
      id: 9, mainFrame,
      on: () => undefined,
      once: () => undefined,
      setWindowOpenHandler: (handler: typeof popup) => { popup = handler; },
    };
    const proposals: unknown[][] = [];
    const window = {
      webContents: contents,
      on: (event: string, handler: () => void) => { if (event === 'close') closeWindow = handler; },
    };
    attachHtmlPreviewWindow(window as unknown as BrowserWindow, manager, { forwardLink: (...values) => { proposals.push(values); } });
    const details = { url: 'https://example.test/path', referrer: { url: '' } } as HandlerDetails;
    assert.deepEqual(popup!(details), { action: 'deny' });
    assert.deepEqual(proposals, [[first.frameName, details.url, first.id]]);
    const second = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 9, frameName: 'tt-preview-b' });
    manager.bindFrame(second.id, 9, second.frameName, 12, 22, 32);
    popup!(details);
    assert.equal(proposals.length, 1, 'multiple no-referrer previews remain fail closed because attribution is ambiguous');
    closeWindow!();
    assert.equal(manager.listForOwner(9).length, 0, 'closing a close-to-tray window revokes every active preview grant');
    assert.equal(manager.hasRetiredOwner(9), true, 'the owner remains fail closed until its WebContents is destroyed');
  } finally { await item.cleanup(); }
});

test('MIME table is explicit and unknown extensions do not sniff', () => {
  const cases: Record<string, string> = {
    'a.html': 'text/html; charset=utf-8', 'a.CSS': 'text/css; charset=utf-8', 'a.mjs': 'text/javascript; charset=utf-8',
    'a.json': 'application/json; charset=utf-8', 'a.svg': 'image/svg+xml; charset=utf-8', 'a.png': 'image/png',
    'a.jpeg': 'image/jpeg', 'a.webp': 'image/webp', 'a.avif': 'image/avif', 'a.woff2': 'font/woff2',
    'a.ttf': 'font/ttf', 'a.mp4': 'video/mp4', 'a.webm': 'video/webm', 'a.mp3': 'audio/mpeg',
    'a.wav': 'audio/wav', 'a.ogg': 'audio/ogg', 'a.unknown': 'application/octet-stream',
  };
  for (const [path, expected] of Object.entries(cases)) assert.equal(mimeTypeForPath(path), expected, path);
});

test('CSP is narrowed to one grant and adds only HTTPS when remote content is allowed', () => {
  const id = 'a'.repeat(32);
  const local = buildPreviewCsp(id, 'http://127.0.0.1:5173');
  assert.match(local, new RegExp(`script-src tt-preview://${id}`));
  assert.match(local, /connect-src tt-preview:\/\/[a-f0-9]{32}(?:;|$)/);
  assert.match(local, /frame-ancestors http:\/\/127\.0\.0\.1:5173/);
  assert.match(local, new RegExp(`frame-ancestors[^;]*tt-preview://${id}`));
  assert.doesNotMatch(local, /https:/);
  assert.doesNotMatch(local, /bypass|service-worker/i);
  const remote = buildPreviewCsp(id, 'file:', true);
  for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src']) {
    assert.match(remote, new RegExp(`${directive}[^;]* https:`), directive);
  }
  assert.match(remote, /frame-ancestors file:/);
  assert.doesNotMatch(remote, /http:(?:\s|;|$)/);
});

test('request decisions block cross-grant, network and host schemes, with opt-in HTTPS only', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  assert.deepEqual(decidePreviewRequest({ targetUrl: 'https://example.test' }), { allow: true, reason: 'not-preview' });
  assert.deepEqual(decidePreviewRequest({ sourceGrantId: a, targetUrl: `tt-preview://${a}/x.js` }), { allow: true, reason: 'same-grant' });
  assert.deepEqual(decidePreviewRequest({ sourceGrantId: a, targetUrl: `tt-preview://${b}/x.js` }), { allow: false, reason: 'cross-grant' });
  assert.deepEqual(decidePreviewRequest({ sourceGrantId: a, targetUrl: 'blob:null/id' }), { allow: true, reason: 'inline-resource' });
  assert.deepEqual(decidePreviewRequest({ sourceGrantId: a, targetUrl: 'https://example.test' }), { allow: false, reason: 'network-blocked' });
  assert.deepEqual(decidePreviewRequest({ sourceGrantId: a, targetUrl: 'https://example.test', remoteContentAllowed: true }), { allow: true, reason: 'remote-https' });
  assert.deepEqual(decidePreviewRequest({ sourceGrantId: a, targetUrl: 'http://127.0.0.1', remoteContentAllowed: true }), { allow: false, reason: 'network-blocked' });
  for (const url of ['file:///etc/passwd', 'mailto:x@example.test', 'ws://127.0.0.1', 'wss://example.test']) assert.equal(decidePreviewRequest({ sourceGrantId: a, targetUrl: url }).allow, false, url);
  assert.deepEqual(decidePreviewRequest({ targetUrl: 'https://example.test', ambiguousPreviewOwner: true }), { allow: false, reason: 'unknown-source' });
});

test('session protocol emits bounded security headers and enforces methods, requests, permissions and downloads', async () => {
  const item = await fixture();
  try {
    const manager = new HtmlPreviewGrantManager({ randomId: ids() });
    const grant = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 9, frameName: 'tt-preview-a' });
    let protocolHandler: ((request: Request) => Promise<Response>) | undefined;
    let beforeRequest: ((details: Record<string, unknown>, callback: (result: { cancel?: boolean }) => void) => void) | undefined;
    let permissionRequest: ((contents: { id: number }, permission: string, callback: (allowed: boolean) => void, details: { requestingUrl: string }) => void) | undefined;
    let permissionCheck: ((contents: { id: number } | null, permission: string, origin: string, details: { requestingUrl?: string; securityOrigin?: string }) => boolean) | undefined;
    let download: ((event: { preventDefault(): void }, item: { getURL(): string }, contents: { id: number }) => void) | undefined;
    const fakeSession = {
      protocol: { handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { protocolHandler = handler; } },
      webRequest: { onBeforeRequest: (handler: typeof beforeRequest) => { beforeRequest = handler; } },
      setPermissionRequestHandler: (handler: typeof permissionRequest) => { permissionRequest = handler; },
      setPermissionCheckHandler: (handler: typeof permissionCheck) => { permissionCheck = handler; },
      on: (_event: string, handler: typeof download) => { download = handler; },
    } as unknown as Session;
    installHtmlPreviewSession(fakeSession, manager, { appFrameAncestor: 'file:' });
    assert.ok(protocolHandler && beforeRequest && permissionRequest && permissionCheck && download);
    const response = await protocolHandler!(new Request(grant.url));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '<!doctype html><title>fixture</title>');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-dns-prefetch-control'), 'off');
    assert.equal(response.headers.get('access-control-allow-origin'), 'null');
    assert.match(response.headers.get('content-security-policy') ?? '', new RegExp(`tt-preview://${grant.id}`));
    assert.equal((await protocolHandler!(new Request(grant.url, { method: 'HEAD' }))).status, 200);
    assert.equal((await protocolHandler!(new Request(grant.url, { method: 'POST' }))).status, 405);
    const request = (details: Record<string, unknown>) => new Promise<boolean>(resolve => beforeRequest!(details, result => resolve(result.cancel === true)));
    const mainFrame = { frameTreeNodeId: 10 } as unknown as WebFrameMain;
    const initialFrame = { url: 'about:blank', parent: mainFrame, frameTreeNodeId: 11, name: 'tt-preview-a' } as unknown as WebFrameMain;
    const owner = { id: 9, mainFrame };
    assert.equal(await request({ url: grant.url, method: 'GET', webContentsId: 9, webContents: owner, frame: initialFrame, referrer: '', resourceType: 'subFrame' }), false);
    const sibling = { ...initialFrame, frameTreeNodeId: 12, name: 'untrusted-sibling' };
    assert.equal(await request({ url: grant.url, method: 'GET', webContentsId: 9, webContents: owner, frame: sibling, referrer: 'data:text/html,x', resourceType: 'subFrame' }), true, 'an opaque sibling cannot read a grant');
    const frame = { url: grant.url, parent: null, frameTreeNodeId: 1, processId: 2 } as unknown as WebFrameMain;
    assert.equal(await request({ url: 'https://example.test', method: 'GET', webContentsId: 9, frame, referrer: grant.url, resourceType: 'xhr' }), true);
    assert.equal(await request({ url: 'file:///etc/passwd', method: 'GET', webContentsId: 9, frame, referrer: grant.url, resourceType: 'subFrame' }), true);
    assert.equal(await request({ url: 'https://orphan.test', method: 'GET', frame: null, referrer: '', resourceType: 'other' }), true, 'unattributed worker request fails closed');
    const permission = (requestingUrl: string) => new Promise<boolean>(resolve => permissionRequest!({ id: 9 }, 'media', resolve, { requestingUrl }));
    assert.equal(await permission(grant.url), false);
    assert.equal(await permission('blob:null/id'), false);
    assert.equal(await permission('about:blank'), false);
    assert.equal(await permission('about:srcdoc'), false);
    assert.equal(await permission('file:///app/index.html'), true);
    assert.equal(permissionCheck!({ id: 9 }, 'media', 'null', { requestingUrl: 'blob:null/id', securityOrigin: 'null' }), false);
    assert.equal(permissionCheck!({ id: 9 }, 'media', 'null', { requestingUrl: 'about:srcdoc', securityOrigin: 'null' }), false);
    assert.equal(permissionCheck!({ id: 9 }, 'media', 'null', { requestingUrl: 'file:///app/index.html', securityOrigin: 'null' }), true, 'packaged app permission behavior is preserved');
    let cancelled = false;
    download!({ preventDefault: () => { cancelled = true; } }, { getURL: () => grant.url }, { id: 9 });
    assert.equal(cancelled, true);
    cancelled = false;
    download!({ preventDefault: () => { cancelled = true; } }, { getURL: () => 'https://app-download.test/file' }, { id: 9 });
    assert.equal(cancelled, false, 'ordinary app downloads retain their previous behavior before a preview is bound');
    manager.bindFrame(grant.id, 9, 'tt-preview-a', 11, 2, 3);
    download!({ preventDefault: () => { cancelled = true; } }, { getURL: () => 'https://preview-download.test/file' }, { id: 9 });
    assert.equal(cancelled, true, 'all downloads are conservatively cancelled while a preview frame is bound');
    manager.setRemoteContentAllowed(grant.id, true);
    assert.equal(await request({ url: 'https://live-remote-worker.test', method: 'GET', webContentsId: 9, frame: null, referrer: 'blob:null/live', resourceType: 'other' }), false,
      'a sole live grant may authorize its unattributed worker before any retirement makes ownership ambiguous');
    manager.revoke(grant.id);
    assert.equal(await request({ url: 'https://post-revoke-owner.test', method: 'GET', webContentsId: 9, frame: null, referrer: '', resourceType: 'other' }), true,
      'the retired owner remains fail closed while its revoked frame may still execute');
    assert.equal(await request({ url: 'https://post-revoke-blob.test', method: 'GET', webContentsId: 9, frame: null, referrer: 'blob:null/worker', resourceType: 'other' }), true,
      'an opaque descendant cannot escape during asynchronous frame teardown');
    assert.equal(await request({ url: 'https://post-revoke-ownerless.test', method: 'GET', frame: null, referrer: 'null', resourceType: 'other' }), true,
      'an ownerless orphan remains fail closed while any retired preview owner exists');
    assert.equal(await permission('blob:null/post-revoke'), false, 'opaque permissions stay denied after the final grant is revoked');
    assert.equal(await permission('about:blank'), false);
    assert.equal(await permission('about:srcdoc'), false);
    assert.equal(await permission('file:///app/index.html'), true, 'ordinary app permissions remain unchanged for a retired preview owner');
    assert.equal(permissionCheck!({ id: 9 }, 'media', 'null', { requestingUrl: 'blob:null/post-revoke', securityOrigin: 'null' }), false);
    assert.equal(permissionCheck!({ id: 9 }, 'media', 'null', { requestingUrl: 'about:blank', securityOrigin: 'null' }), false);
    assert.equal(permissionCheck!({ id: 9 }, 'media', 'null', { requestingUrl: 'about:srcdoc', securityOrigin: 'null' }), false);
    assert.equal(permissionCheck!(null, 'media', 'null', { requestingUrl: '', securityOrigin: 'null' }), false,
      'an ownerless opaque permission check stays fail closed while a retired owner exists');
    cancelled = false;
    download!({ preventDefault: () => { cancelled = true; } }, { getURL: () => 'https://post-revoke-download.test/file' }, { id: 9 });
    assert.equal(cancelled, true, 'the owning WebContents cannot start a download during or after revoked-frame teardown');
    const replacement = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 9, frameName: 'tt-preview-b', remoteContentAllowed: true });
    assert.equal(await request({ url: 'https://replacement-remote.test', method: 'GET', webContentsId: 9, frame: null, referrer: 'blob:null/old-worker', resourceType: 'other' }), true,
      'an orphan from a retired grant cannot borrow a new sole grant remote-content permission');
    assert.equal(await request({ url: grant.url, method: 'GET', referrer: '', resourceType: 'other' }), false, 'an unknown grant reaches the protocol handler for an explicit 404');
    assert.equal((await protocolHandler!(new Request(grant.url))).status, 404, 'revocation immediately closes the capability URL');
    manager.releaseOwner(9);
    assert.equal(manager.get(replacement.id), undefined);
    assert.equal(await request({ url: 'https://after-owner-destroyed.test', method: 'GET', webContentsId: 9, frame: null, referrer: '', resourceType: 'other' }), false,
      'destroying the owning WebContents releases its retirement marker');
    assert.equal(await request({ url: 'https://after-all-owners-destroyed.test', method: 'GET', frame: null, referrer: 'null', resourceType: 'other' }), false,
      'ownerless requests return to ordinary session behavior only after all preview owners are gone');
    assert.equal(await permission('blob:null/after-owner-destroyed'), true);
    assert.equal(await permission('about:blank'), true);
    assert.equal(await permission('about:srcdoc'), true);
    assert.equal(permissionCheck!(null, 'media', 'null', { requestingUrl: '', securityOrigin: 'null' }), true);
    cancelled = false;
    download!({ preventDefault: () => { cancelled = true; } }, { getURL: () => 'https://after-owner-destroyed.test/file' }, { id: 9 });
    assert.equal(cancelled, false);
  } finally { await item.cleanup(); }
});

test('process isolation feature merging and evidence are deterministic', () => {
  assert.equal(mergePreviewIsolationFeatures(''), 'IsolateSandboxedIframes');
  assert.equal(mergePreviewIsolationFeatures('A,B'), 'A,B,IsolateSandboxedIframes');
  assert.equal(mergePreviewIsolationFeatures('A,IsolateSandboxedIframes,B'), 'A,IsolateSandboxedIframes,B');
  assert.deepEqual(previewProcessIsolation(10, 20), { isolated: true, appOsProcessId: 10, previewOsProcessId: 20 });
  assert.equal(previewProcessIsolation(10, 10).isolated, false);
  assert.equal(previewProcessIsolation(0, 20).isolated, false);
});

test('WebRTC policy covers preview frames and descendants without affecting unrelated app frames', async () => {
  const item = await fixture();
  try {
    const manager = new HtmlPreviewGrantManager({ randomId: ids() });
    const grant = await manager.create({ rootPath: item.root, entryPath: 'site/index.html', ownerWebContentsId: 9, frameName: 'tt-preview-a' });
    const top = { frameTreeNodeId: 1, url: 'file:///app/index.html', parent: null } as unknown as WebFrameMain;
    const initial = { frameTreeNodeId: 2, name: grant.frameName, url: '', parent: top, top } as unknown as WebFrameMain;
    assert.equal(shouldDisableHtmlPreviewWebRtc(initial, 9, manager), true, 'the exact initial grant child is covered before its URL is observable');
    const preview = { frameTreeNodeId: 2, name: grant.frameName, url: grant.url, parent: top, top } as unknown as WebFrameMain;
    const descendant = { frameTreeNodeId: 3, name: '', url: 'about:blank', parent: preview, top } as unknown as WebFrameMain;
    assert.equal(shouldDisableHtmlPreviewWebRtc(descendant, 9, manager), true);
    const unknown = { ...preview, url: 'tt-preview://ffffffffffffffffffffffffffffffff/index.html' } as unknown as WebFrameMain;
    assert.equal(shouldDisableHtmlPreviewWebRtc(unknown, 9, manager), true, 'unknown preview origins fail closed');
    const appChild = { ...initial, name: 'ordinary-app-frame' } as unknown as WebFrameMain;
    assert.equal(shouldDisableHtmlPreviewWebRtc(appChild, 9, manager), false);
    assert.equal(shouldDisableHtmlPreviewWebRtc(initial, 10, manager), false);
  } finally { await item.cleanup(); }
});

// Electron keeps only the last registerSchemesAsPrivileged call: a second one (D1 added one for threadterm-bg) stripped
// tt-preview of supportFetchAPI, so fetch() inside HTML previews failed. Every privileged scheme goes through one call.
test('every privileged scheme is registered in a single registerSchemesAsPrivileged call', () => {
  const desktop = join(process.cwd(), 'desktop', 'src');
  const calls = readdirSync(desktop).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .flatMap(name => (readFileSync(join(desktop, name), 'utf8').match(/\.registerSchemesAsPrivileged\(\[[^\]]*\]/g) ?? []).map(call => `${name}: ${call}`));
  assert.equal(calls.length, 1, calls.join('\n'));
  assert.match(calls[0], /^main\.ts: .*HTML_PREVIEW_PRIVILEGED_SCHEME.*BACKGROUND_IMAGE_PRIVILEGED_SCHEME/);
  assert.deepEqual(HTML_PREVIEW_PRIVILEGED_SCHEME.privileges, { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true });
});
