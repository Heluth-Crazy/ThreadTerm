import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backgroundFolders, listBackgroundImages, storeBackgroundImage, type ImageStats } from './backgroundImagesCore.js';
import { buildThemeExport, importThemePackImages, MAX_THEME_PACK_IMAGE_BYTES, qaThemeExportOverride, themeBackgroundImageIds, ThemePackError } from './themePackCore.js';

// The desktop test runner bundles this file to CJS and runs it from the repo root; scratch lives in the system temp dir.

const scratch = () => mkdtempSync(join(tmpdir(), 'tt-theme-pack-'));
const stats: ImageStats = { dark: [[12, 12, 20]], bright: [[240, 240, 250]] };

/** A minimal VP8L WebP: 0x2f signature, then 14-bit width-1 and height-1 (same fixture as backgroundImagesCore.test.ts). */
function webpLossless(width: number, height: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(bytes.buffer).setUint32(4, 40, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
  new DataView(bytes.buffer).setUint32(16, 20, true);
  bytes[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  new DataView(bytes.buffer).setUint32(21, bits, true);
  bytes[41] = seed;
  return bytes;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const palette = { background: '#1a1b26', surface: '#1f2335', text: '#c0caf5', muted: '#7aa2f7', accent: '#7aa2f7', border: '#1f2335' };
const layer = (image: string) => ({ image, opacity: 100, blur: 0, overlay: 60, fit: 'cover', focusX: 50, focusY: 50, scale: 100 });

test('image ids are collected from every region of every theme, and never from a malformed layer', () => {
  const one = 'a'.repeat(64), two = 'b'.repeat(64);
  assert.deepEqual(themeBackgroundImageIds({ 'Night (custom)': { ...palette, backgrounds: { window: layer(one), chat: layer(two) } }, other: { ...palette, backgrounds: { editor: layer(one) } } }).sort(), [one, two].sort());
  assert.deepEqual(themeBackgroundImageIds({ plain: palette }), []);
  assert.deepEqual(themeBackgroundImageIds(undefined), []);
  assert.deepEqual(themeBackgroundImageIds('nope'), []);
  assert.deepEqual(themeBackgroundImageIds({ t: { ...palette, backgrounds: { window: { image: '../../manifest.json' }, chat: { image: 7 }, editor: null } } }), []);
  assert.deepEqual(themeBackgroundImageIds({ t: { ...palette, backgrounds: [] } }), []);
  // A layer that shows the window picture has no picture of its own to embed.
  assert.deepEqual(themeBackgroundImageIds({ t: { ...palette, backgrounds: { window: layer(one), chat: layer('inherit') } } }), [one]);
  assert.deepEqual(themeBackgroundImageIds({ t: { ...palette, backgrounds: { chat: layer('inherit') } } }), []);
});

test('a pack whose themes only inherit the window picture is still a plain export', async () => {
  const folder = scratch();
  try {
    const themes = { Inherit: { ...palette, backgrounds: { chat: layer('inherit') } } };
    const exported = await buildThemeExport(folder, themes);
    assert.deepEqual(exported.pack, themes);
    assert.deepEqual(exported.images, []);
    assert.deepEqual(exported.missing, []);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a palette-only export is still today\'s plain JSON', async () => {
  const folder = scratch();
  try {
    const themes = { Ocean: { ...palette, base: 'tokyo-night' } };
    const exported = await buildThemeExport(folder, themes);
    assert.deepEqual(exported.pack, themes);
    assert.equal('threadtermThemePack' in (exported.pack as Record<string, unknown>), false);
    assert.deepEqual(exported.images, []);
    assert.deepEqual(exported.missing, []);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('an export with backgrounds embeds the referenced pictures byte for byte', async () => {
  const folder = scratch();
  try {
    const window = webpLossless(800, 600, 1), chat = webpLossless(640, 480, 2);
    const windowRecord = await storeBackgroundImage(folder, { name: 'window.webp', bytes: window, width: 800, height: 600, stats });
    const chatRecord = await storeBackgroundImage(folder, { name: 'chat.webp', bytes: chat, width: 640, height: 480, stats });
    const themes = { 'Tokyo Night (custom)': { ...palette, base: 'tokyo-night', backgrounds: { window: layer(windowRecord.id), chat: layer(chatRecord.id) } } };
    const exported = await buildThemeExport(folder, themes);
    const pack = exported.pack as { threadtermThemePack: number; themes: unknown; images: Record<string, { name: string; webp: string }> };
    assert.equal(pack.threadtermThemePack, 2);
    assert.deepEqual(pack.themes, themes);
    assert.deepEqual(exported.images.sort(), [windowRecord.id, chatRecord.id].sort());
    assert.deepEqual(exported.missing, []);
    for (const [id, bytes, name] of [[windowRecord.id, window, 'window.webp'], [chatRecord.id, chat, 'chat.webp']] as const) {
      assert.equal(sha(Uint8Array.from(Buffer.from(pack.images[id].webp, 'base64'))), id, 'the embedded picture hashes to its id');
      assert.deepEqual(Uint8Array.from(Buffer.from(pack.images[id].webp, 'base64')), bytes, 'the embedded picture is the stored file');
      assert.equal(pack.images[id].name, name);
    }
    // The stored files are untouched by an export.
    assert.deepEqual(readFileSync(join(backgroundFolders(folder).images, `${windowRecord.id}.webp`)), Buffer.from(window));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('an image the store lost is skipped and reported, and the pack stays plain when nothing is left', async () => {
  const folder = scratch();
  try {
    const stored = webpLossless(200, 100, 3);
    const record = await storeBackgroundImage(folder, { name: 'one.webp', bytes: stored, width: 200, height: 100, stats });
    const gone = 'f'.repeat(64);
    const themes = { Mix: { ...palette, backgrounds: { window: layer(record.id), chat: layer(gone) } } };
    const mixed = await buildThemeExport(folder, themes);
    assert.deepEqual(mixed.images, [record.id]);
    assert.deepEqual(mixed.missing, [gone]);
    assert.equal((mixed.pack as { threadtermThemePack: number }).threadtermThemePack, 2);
    const onlyGone = await buildThemeExport(folder, { Mix: { ...palette, backgrounds: { window: layer(gone) } } });
    assert.deepEqual(onlyGone.images, []);
    assert.deepEqual(onlyGone.missing, [gone]);
    assert.deepEqual(onlyGone.pack, { Mix: { ...palette, backgrounds: { window: layer(gone) } } });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the export stops with a code when the pictures together are too large', async () => {
  const folder = scratch();
  try {
    const one = webpLossless(64, 64, 4), two = webpLossless(64, 64, 5);
    const first = await storeBackgroundImage(folder, { name: 'a.webp', bytes: one, width: 64, height: 64, stats });
    const second = await storeBackgroundImage(folder, { name: 'b.webp', bytes: two, width: 64, height: 64, stats });
    const themes = { Big: { ...palette, backgrounds: { window: layer(first.id), chat: layer(second.id) } } };
    await assert.rejects(() => buildThemeExport(folder, themes, { maxImageBytes: 81 }), (error: unknown) => error instanceof ThemePackError && error.code === 'theme_pack_too_large');
    assert.ok(MAX_THEME_PACK_IMAGE_BYTES >= 64 * 1024 * 1024, 'the default budget is 64 MiB of pictures');
    const ok = await buildThemeExport(folder, themes, { maxImageBytes: 96 });
    assert.equal(ok.images.length, 2);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('importing a pack validates every picture and stores it under its own hash', async () => {
  const folder = scratch();
  try {
    const good = webpLossless(800, 600, 6), other = webpLossless(320, 200, 7);
    const goodId = sha(good), otherId = sha(other);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const oversized = webpLossless(3841, 100, 8);
    const stored = await importThemePackImages(folder, [
      { id: goodId, name: 'window.webp', webp: base64(good), stats },
      // The id is not the hash of these bytes: refused, the rest still imports.
      { id: otherId, name: 'tampered.webp', webp: base64(good) },
      // A PNG renamed to .webp is refused (only prepared WebP pictures are stored).
      { id: sha(png), name: 'fake.webp', webp: base64(png) },
      // Beyond the 3840 px edge cap.
      { id: sha(oversized), name: 'huge.webp', webp: base64(oversized) },
      { id: goodId, name: 'again.webp', webp: 'not base64!' },
      { id: 'short', name: 'x', webp: base64(other) },
    ]);
    assert.deepEqual(stored.map(record => record.id), [goodId]);
    assert.equal(stored[0].name, 'window.webp');
    assert.equal(stored[0].width, 800);
    assert.equal(stored[0].height, 600);
    assert.deepEqual(stored[0].stats, stats, 'the statistics from the pack are kept');
    assert.deepEqual(readFileSync(join(backgroundFolders(folder).images, `${goodId}.webp`)), Buffer.from(good));
    assert.deepEqual((await listBackgroundImages(folder)).map(record => record.id), [goodId]);
    // Identical bytes dedupe to one record, and without statistics the record still stores.
    const deduped = await importThemePackImages(folder, [{ id: goodId, name: 'copy.webp', webp: base64(good) }, { id: sha(other), name: 'chat.webp', webp: base64(other), stats: 'nope' }]);
    assert.deepEqual(deduped.map(record => record.id), [goodId, sha(other)]);
    assert.deepEqual(deduped[0].stats, stats, 'dedupe keeps the first record');
    assert.deepEqual(deduped[1].stats, { dark: [], bright: [] }, 'invalid statistics fall back to an empty set');
    assert.equal((await listBackgroundImages(folder)).length, 2);
    assert.deepEqual(await importThemePackImages(folder, []), []);
    await assert.rejects(() => importThemePackImages(folder, 'nope'), (error: unknown) => error instanceof ThemePackError && error.code === 'theme_pack_unreadable');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('an export imported into an empty profile gives back the same pictures and themes', async () => {
  const source = scratch(), target = scratch();
  try {
    const window = webpLossless(1024, 768, 9), chat = webpLossless(512, 512, 10);
    const windowRecord = await storeBackgroundImage(source, { name: 'window.webp', bytes: window, width: 1024, height: 768, stats });
    const chatRecord = await storeBackgroundImage(source, { name: 'chat.webp', bytes: chat, width: 512, height: 512, stats });
    const themes = { 'Tokyo Night (custom)': { ...palette, base: 'tokyo-night', backgrounds: { window: layer(windowRecord.id), chat: layer(chatRecord.id) } } };
    const { pack } = await buildThemeExport(source, themes);
    const images = Object.entries((pack as { images: Record<string, { name: string; webp: string }> }).images).map(([id, entry]) => ({ id, ...entry }));
    const imported = await importThemePackImages(target, images);
    assert.deepEqual(imported.map(record => record.id).sort(), [chatRecord.id, windowRecord.id].sort());
    for (const record of imported) {
      const original = record.id === windowRecord.id ? window : chat;
      assert.deepEqual(readFileSync(join(backgroundFolders(target).images, `${record.id}.webp`)), Buffer.from(original));
    }
    assert.deepEqual((await listBackgroundImages(target)).map(record => record.width).sort((left, right) => left - right), [512, 1024]);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('the QA export override only accepts an absolute path in an unpackaged build', () => {
  const absolute = process.platform === 'win32' ? 'C:\\temp\\pack.json' : '/tmp/pack.json';
  assert.equal(qaThemeExportOverride(absolute, false), absolute);
  assert.equal(qaThemeExportOverride(absolute, true), undefined);
  assert.equal(qaThemeExportOverride('relative/pack.json', false), undefined);
  assert.equal(qaThemeExportOverride(undefined, false), undefined);
  assert.equal(qaThemeExportOverride('', false), undefined);
  assert.equal(qaThemeExportOverride(`${absolute}${'x'.repeat(4100)}`, false), undefined);
});
