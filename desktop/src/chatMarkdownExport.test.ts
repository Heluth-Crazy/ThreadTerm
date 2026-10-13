import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcMainInvokeEvent, SaveDialogOptions } from 'electron';
import { nativeMarkdownExportFiles, saveChatMarkdown, writeChatMarkdownAtomic } from './chatMarkdownExport.js';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const event = {} as IpcMainInvokeEvent;
function fixture() {
  const writes: [string, string][] = [], dialogs: SaveDialogOptions[] = [];
  const deps = { assertTrusted: () => {}, choosePath: async (options: SaveDialogOptions) => { dialogs.push(options); return { canceled: false, filePath: 'chosen.md' }; }, write: async (path: string, content: string) => { writes.push([path, content]); }, alive: () => true };
  return { writes, dialogs, deps };
}
test('Markdown export checks trust before opening a dialog', async () => {
  const { deps, dialogs, writes } = fixture(); deps.assertTrusted = () => { throw new Error('Untrusted renderer'); };
  await assert.rejects(saveChatMarkdown(event, null, deps), /Untrusted renderer/);
  assert.equal(dialogs.length, 0); assert.equal(writes.length, 0);
});
test('Markdown export writes selected path and exact UTF8 content', async () => {
  const { deps, dialogs, writes } = fixture();
  assert.equal(await saveChatMarkdown(event, { title: '中文 / title', markdown: '中文\r\n```ts\ncode\n```', locale: 'zh-CN' }, deps), 'chosen.md');
  assert.deepEqual(writes, [['chosen.md', '中文\r\n```ts\ncode\n```']]); assert.equal(dialogs[0]!.defaultPath, '中文 - title.md');
});
test('cancel and renderer close leave no pending write', async () => {
  for (const closed of [false, true]) {
    const { deps, writes } = fixture(); deps.alive = () => !closed;
    if (!closed) deps.choosePath = async () => ({ canceled: true, filePath: 'ignored.md' });
    assert.equal(await saveChatMarkdown(event, { title: 'a', markdown: 'b' }, deps), null); assert.equal(writes.length, 0);
  }
});
test('invalid export cannot supply arbitrary paths or oversized content', async () => {
  const { deps, dialogs } = fixture();
  for (const payload of [{ title: 'a', markdown: 'b', path: 'arbitrary.md' }, { title: 'a', markdown: false }, { title: 'a', markdown: 'x'.repeat(64 * 1024 * 1024 + 1) }]) await assert.rejects(saveChatMarkdown(event, payload, deps), /Invalid/);
  assert.equal(dialogs.length, 0);
});
test('save failure propagates for retry', async () => {
  const { deps } = fixture(); deps.write = async () => { throw new Error('disk full'); };
  await assert.rejects(saveChatMarkdown(event, { title: 'a', markdown: 'b' }, deps), /disk full/);
});
const assetToken = '__THREADTERM_CHAT_ASSETS_00000000-0000-0000-0000-000000000000__';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const payload = () => ({ title: 'images', markdown: `中文 ![Image](<${assetToken}/image-1.png>)`, assetToken, images: [{ name: 'image-1.png', dataUrl: png }] });
function assetsFixture() {
  const base = fixture(), operations: string[] = [], contents: Buffer[] = [];
  const files = {
    createDirectory: async (path: string) => { operations.push(`mkdir:${path}`); },
    writeImage: async (path: string, bytes: Buffer) => { operations.push(`image:${path}`); contents.push(bytes); },
    unlink: async (path: string) => { operations.push(`unlink:${path}`); },
    removeDirectory: async (path: string) => { operations.push(`rmdir:${path}`); },
  };
  return { ...base, operations, contents, files, deps: { ...base.deps, files } };
}
test('companion images use decoded bytes, generated sibling directories and relative references', async () => {
  const { deps, writes, operations, contents } = assetsFixture();
  await saveChatMarkdown(event, payload(), deps); await saveChatMarkdown(event, payload(), deps);
  assert.equal(contents[0]!.toString('base64'), png.split(',')[1]);
  assert.match(writes[0]![1], /<threadterm-chat-images-[a-f0-9-]{36}\/image-1.png>/);
  assert.doesNotMatch(writes[0]![1], /base64|__THREADTERM/);
  assert.notEqual(operations[0], operations[2]); assert.equal(operations.filter(op => op.startsWith('unlink:') || op.startsWith('rmdir:')).length, 0);
});
test('image export rejects spoofed names, unsupported data and invalid references before the dialog', async () => {
  const { deps, dialogs, operations } = assetsFixture();
  const invalid: unknown[] = [
    { ...payload(), images: [{ name: '../image.png', dataUrl: png }] },
    { ...payload(), images: [{ name: 'image-1.jpeg', dataUrl: png }] },
    { ...payload(), images: [{ name: 'image-1.png', dataUrl: png, path: 'elsewhere' }] },
    { ...payload(), images: new Array(1) }, { ...payload(), images: new Array(1001) },
    { ...payload(), assetToken: '../assets' }, { ...payload(), assetToken: undefined },
    { ...payload(), markdown: 'missing reference' }, { ...payload(), markdown: `${payload().markdown} ${assetToken}` },
    { ...payload(), markdown: `<${assetToken}/image-2.png>` },
  ];
  for (const dataUrl of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png', 'C:/source.png', 'data:image/png;base64,AAAA', 'data:image/png;base64,iVBORw0KGgp=', 'data:image/png;base64,iVBORw0KGgo===', 'data:image/jpeg;base64,iVBORw0KGgo=']) invalid.push({ ...payload(), images: [{ name: 'image-1.png', dataUrl }] });
  for (const value of invalid) await assert.rejects(saveChatMarkdown(event, value, deps), /Invalid/);
  assert.equal(dialogs.length, 0); assert.deepEqual(operations, []);
});
test('combined Markdown and image budget is enforced before decoding or opening the dialog', async () => {
  const { deps, dialogs } = assetsFixture();
  await assert.rejects(saveChatMarkdown(event, { ...payload(), markdown: payload().markdown + 'x'.repeat(64 * 1024 * 1024 - Buffer.byteLength(payload().markdown)) }, deps), /size/);
  assert.equal(dialogs.length, 0);
});
test('raster MIME signatures retain array order, including the 1000-image boundary', async () => {
  const { deps, contents } = assetsFixture();
  const data = [png, 'data:image/jpeg;base64,/9j/', 'data:image/gif;base64,R0lGODlh', 'data:image/webp;base64,UklGRgAAAABXRUJQ'];
  const extensions = ['png', 'jpeg', 'gif', 'webp'];
  const images = Array.from({ length: 1000 }, (_, i) => ({ name: `image-${i + 1}.${extensions[i % 4]}`, dataUrl: data[i % 4]! }));
  await saveChatMarkdown(event, { title: 'all', assetToken, images, markdown: images.map(image => `<${assetToken}/${image.name}>`).join('\n') }, deps);
  assert.equal(contents.length, 1000); assert.equal(contents[3]!.subarray(8).toString(), 'WEBP');
});
test('zero-image and cancelled exports create no companion directory', async () => {
  const { deps, operations } = assetsFixture();
  await saveChatMarkdown(event, { title: 'plain', markdown: '<undefined/image-1.png>', images: [], assetToken }, deps);
  deps.choosePath = async () => ({ canceled: true, filePath: 'ignored.md' });
  await saveChatMarkdown(event, payload(), deps); assert.deepEqual(operations, []);
});
test('sender closure at every image boundary cleans only completed owned files', async () => {
  for (const boundary of ['dialog', 'directory', 'image', 'publish']) {
    const { deps, files, writes, operations } = assetsFixture(); let alive = true; deps.alive = () => alive;
    if (boundary === 'dialog') deps.choosePath = async () => { alive = false; return { canceled: false, filePath: 'chosen.md' }; };
    if (boundary === 'directory') files.createDirectory = async path => { operations.push(`mkdir:${path}`); alive = false; };
    if (boundary === 'image') files.writeImage = async path => { operations.push(`image:${path}`); alive = false; };
    if (boundary === 'publish') deps.alive = () => { if (operations.some(op => op.startsWith('image:'))) alive = false; return alive; };
    assert.equal(await saveChatMarkdown(event, payload(), deps), null); assert.equal(writes.length, 0);
    assert.equal(operations.filter(op => op.startsWith('unlink:')).length, ['image', 'publish'].includes(boundary) ? 1 : 0);
    assert.equal(operations.filter(op => op.startsWith('rmdir:')).length, boundary === 'dialog' ? 0 : 1);
  }
});
test('trust is rechecked after the modal and image writes', async () => {
  for (const boundary of ['dialog', 'image']) {
    const { deps, files, writes, operations } = assetsFixture(); let trusted = true;
    deps.assertTrusted = () => { if (!trusted) throw new Error('Renderer navigated'); };
    if (boundary === 'dialog') deps.choosePath = async () => { trusted = false; return { canceled: false, filePath: 'chosen.md' }; };
    else files.writeImage = async path => { operations.push(`image:${path}`); trusted = false; };
    await assert.rejects(saveChatMarkdown(event, payload(), deps), /Renderer navigated/); assert.equal(writes.length, 0);
    assert.equal(operations.filter(op => op.startsWith('unlink:')).length, boundary === 'image' ? 1 : 0);
  }
});
test('directory, exclusive-image and Markdown failures clean only this export assets', async () => {
  for (const boundary of ['directory', 'image', 'markdown']) {
    const { deps, files, operations } = assetsFixture();
    if (boundary === 'directory') files.createDirectory = async () => { throw new Error('EEXIST'); };
    if (boundary === 'image') files.writeImage = async () => { throw new Error('EEXIST'); };
    if (boundary === 'markdown') deps.write = async () => { throw new Error('disk full'); };
    await assert.rejects(saveChatMarkdown(event, payload(), deps), /EEXIST|disk full/);
    assert.equal(operations.filter(op => op.startsWith('unlink:')).length, boundary === 'markdown' ? 1 : 0);
    assert.equal(operations.filter(op => op.startsWith('rmdir:')).length, boundary === 'directory' ? 0 : 1);
  }
});
test('cleanup errors retain the original save failure', async () => {
  const { deps, files } = assetsFixture(); deps.write = async () => { throw new Error('disk full'); };
  files.unlink = async () => { throw new Error('cleanup denied'); };
  await assert.rejects(saveChatMarkdown(event, payload(), deps), error => error instanceof AggregateError && /cleanup incomplete/.test(error.message) && error.errors.some(item => item.message === 'disk full'));
});
test('atomic Markdown publication preserves existing content on cancellation and replaces it completely on success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadterm-chat-export-')), target = join(directory, 'chat.md');
  try {
    await writeFile(target, 'original');
    assert.equal(await writeChatMarkdownAtomic(target, 'cancelled', () => false), false);
    assert.equal(await readFile(target, 'utf8'), 'original'); assert.deepEqual(await readdir(directory), ['chat.md']);
    assert.equal(await writeChatMarkdownAtomic(target, '中文\r\ncomplete', () => true), true);
    assert.equal(await readFile(target, 'utf8'), '中文\r\ncomplete'); assert.deepEqual(await readdir(directory), ['chat.md']);
  } finally { await unlink(target); await rmdir(directory); }
});
test('native exclusive asset writes preserve colliding files and directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadterm-chat-export-')), target = join(directory, 'image.png');
  try {
    await writeFile(target, 'owned by someone else');
    await assert.rejects(nativeMarkdownExportFiles.writeImage(target, Buffer.from('new')), /EEXIST/);
    await assert.rejects(nativeMarkdownExportFiles.createDirectory(directory), /EEXIST/);
    assert.equal(await readFile(target, 'utf8'), 'owned by someone else');
  } finally { await unlink(target); await rmdir(directory); }
});
test('atomic publication failure cleans the temporary file and leaves its target intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadterm-chat-export-'));
  try {
    await assert.rejects(writeChatMarkdownAtomic(directory, 'cannot replace a directory', () => true));
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(writeChatMarkdownAtomic(join(directory, 'chat.md'), 'stale', () => { throw new Error('Renderer navigated'); }), /Renderer navigated/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rmdir(directory); }
});
