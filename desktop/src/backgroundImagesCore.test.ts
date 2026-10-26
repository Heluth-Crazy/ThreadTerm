import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BACKGROUND_IMAGE_SCHEME,
  BackgroundImageError,
  backgroundErrorCode,
  backgroundFolders,
  backgroundImageUrl,
  backgroundRequestPath,
  listBackgroundImages,
  MAX_BACKGROUND_IMAGES,
  MAX_BACKGROUND_SOURCE_BYTES,
  MAX_BACKGROUND_STORED_BYTES,
  parseBackgroundManifest,
  parseBackgroundUrl,
  pruneBackgroundImages,
  qaBackgroundPickOverride,
  readBackgroundManifest,
  readBackgroundSource,
  removeBackgroundImage,
  sniffImageBytes,
  storeBackgroundImage,
  storeBackgroundVariant,
  webpDimensions,
  writeBackgroundManifest,
  type ImageStats,
} from './backgroundImagesCore.js';

// The desktop test runner bundles this file to CJS and runs it from the repo root; scratch lives in the system temp dir.

const scratch = () => mkdtempSync(join(tmpdir(), 'tt-background-images-'));

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

function jpegBytes(): Uint8Array { return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 0xff, 0xd9]); }

function bmpBytes(): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set([0x42, 0x4d], 0);
  new DataView(bytes.buffer).setUint32(2, 54, true);
  return bytes;
}

function avifBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  bytes.set([0x61, 0x76, 0x69, 0x66], 8); // 'avif'
  return bytes;
}

/** A minimal VP8L WebP header: 0x2f signature then 14-bit width-1 and height-1. */
function webpLossless(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(bytes.buffer).setUint32(4, 32, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
  new DataView(bytes.buffer).setUint32(16, 12, true);
  bytes[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  new DataView(bytes.buffer).setUint32(21, bits, true);
  return bytes;
}

/** A minimal VP8X WebP header (1x1 canvas in the header, sizes given explicitly). */
function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, 32, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  new DataView(bytes.buffer).setUint32(16, 12, true);
  const write24 = (offset: number, value: number) => { bytes[offset] = value & 0xff; bytes[offset + 1] = (value >> 8) & 0xff; bytes[offset + 2] = (value >> 16) & 0xff; };
  write24(24, width - 1); write24(27, height - 1);
  return bytes;
}

const stats: ImageStats = { dark: [[0, 0, 0], [60, 10, 10]], bright: [[255, 255, 255]] };

test('magic bytes decide the format; GIF, SVG and text are named rejections', () => {
  assert.deepEqual(sniffImageBytes(pngHeader(8, 8)), { ok: true, format: 'png', mime: 'image/png' });
  assert.deepEqual(sniffImageBytes(jpegBytes()), { ok: true, format: 'jpeg', mime: 'image/jpeg' });
  assert.deepEqual(sniffImageBytes(webpLossless(8, 8)), { ok: true, format: 'webp', mime: 'image/webp' });
  assert.deepEqual(sniffImageBytes(avifBytes()), { ok: true, format: 'avif', mime: 'image/avif' });
  assert.deepEqual(sniffImageBytes(bmpBytes()), { ok: true, format: 'bmp', mime: 'image/bmp' });
  assert.deepEqual(sniffImageBytes(new TextEncoder().encode('GIF89a\x01\x00\x01\x00')), { ok: false, reason: 'gif' });
  assert.deepEqual(sniffImageBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), { ok: false, reason: 'svg' });
  assert.deepEqual(sniffImageBytes(new TextEncoder().encode('<?xml version="1.0"?><svg viewBox="0 0 1 1"/>')), { ok: false, reason: 'svg' });
  assert.deepEqual(sniffImageBytes(new TextEncoder().encode('just a note, renamed to .png')), { ok: false, reason: 'text' });
  assert.deepEqual(sniffImageBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xfe])), { ok: false, reason: 'unknown' });
  assert.deepEqual(sniffImageBytes(new Uint8Array()), { ok: false, reason: 'unknown' });
});

test('the WebP header is read for VP8L, VP8X and lossy VP8', () => {
  assert.deepEqual(webpDimensions(webpLossless(3840, 2160)), { width: 3840, height: 2160 });
  assert.deepEqual(webpDimensions(webpExtended(1920, 1080)), { width: 1920, height: 1080 });
  const lossy = webpLossless(4, 4);
  lossy.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 '
  lossy.fill(0, 20, 40);
  lossy.set([0x9d, 0x01, 0x2a], 23);
  lossy[26] = 0x00; lossy[27] = 0x0f; lossy[28] = 0x70; lossy[29] = 0x08; // 3840 x 2160
  assert.deepEqual(webpDimensions(lossy), { width: 3840, height: 2160 });
  assert.equal(webpDimensions(pngHeader(8, 8)), undefined);
  assert.equal(webpDimensions(new Uint8Array(4)), undefined);
});

test('the manifest round-trips and keeps only records that satisfy the caps', async () => {
  const folder = scratch();
  try {
    const record = await storeBackgroundImage(folder, { name: 'photo.png', bytes: webpLossless(3840, 2160), width: 3840, height: 2160, stats });
    assert.equal(record.width, 3840, 'dimensions come from the WebP header, not from the caller');
    assert.equal(record.height, 2160);
    assert.equal(record.name, 'photo.png');
    assert.deepEqual(record.stats, stats);
    assert.match(record.id, /^[a-f0-9]{64}$/);
    assert.equal(record.id, createHash('sha256').update(webpLossless(3840, 2160)).digest('hex'));
    assert.equal(statSync(join(backgroundFolders(folder).images, `${record.id}.webp`)).size, webpLossless(3840, 2160).length);
    const listed = await listBackgroundImages(folder);
    assert.deepEqual(listed.map(item => item.id), [record.id]);

    const text = readFileSync(backgroundFolders(folder).manifest, 'utf8');
    assert.match(text, /"version": 1/);
    const parsed = parseBackgroundManifest(text);
    assert.deepEqual(parsed?.images[0].stats, stats);

    writeFileSync(backgroundFolders(folder).manifest, '{ not json');
    const warnings: string[] = [];
    const rebuilt = await readBackgroundManifest(folder, { warn: (...args: unknown[]) => { warnings.push(String(args[0])); } });
    assert.deepEqual(rebuilt.images, [], 'a corrupt manifest rebuilds empty');
    assert.equal(warnings.length, 1);
    assert.deepEqual(parseBackgroundManifest(readFileSync(backgroundFolders(folder).manifest, 'utf8'))?.images, [], 'and the rebuilt file is written');
    assert.equal(parseBackgroundManifest('[]'), undefined);
    assert.equal(parseBackgroundManifest('{"images":3}'), undefined);
    assert.deepEqual(parseBackgroundManifest('{"images":[{"id":"nope"}]}')?.images, [], 'invalid records are dropped');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a missing manifest is empty and is not written until something is stored', async () => {
  const folder = scratch();
  try {
    assert.deepEqual(await listBackgroundImages(folder), []);
    assert.equal(statIsMissing(join(backgroundFolders(folder).manifest)), true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
function statIsMissing(path: string): boolean {
  try { statSync(path); return false; } catch { return true; }
}

test('re-importing identical bytes dedupes to one record and one file', async () => {
  const folder = scratch();
  try {
    const first = await storeBackgroundImage(folder, { name: 'a.webp', bytes: webpLossless(100, 50), width: 100, height: 50, stats });
    const second = await storeBackgroundImage(folder, { name: 'b.webp', bytes: webpLossless(100, 50), width: 100, height: 50, stats });
    assert.equal(second.id, first.id);
    assert.equal(second.name, 'a.webp', 'the first import keeps its name');
    assert.equal((await listBackgroundImages(folder)).length, 1);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('caps: 16 MiB stored bytes, 3840 px, the image count and the source file cap', async () => {
  const folder = scratch();
  try {
    const tooBig = new Uint8Array(MAX_BACKGROUND_STORED_BYTES + 1);
    tooBig.set(webpLossless(8, 8).slice(0, 40));
    await assert.rejects(storeBackgroundImage(folder, { bytes: tooBig, width: 8, height: 8 }), (error: unknown) => backgroundErrorCode(error) === 'background_image_too_large');
    await assert.rejects(storeBackgroundImage(folder, { bytes: pngHeader(8, 8), width: 8, height: 8 }), (error: unknown) => backgroundErrorCode(error) === 'background_image_unsupported');
    await assert.rejects(storeBackgroundImage(folder, { bytes: webpLossless(5000, 100) }), (error: unknown) => backgroundErrorCode(error) === 'background_image_unreadable');
    await assert.rejects(storeBackgroundImage(folder, { bytes: new Uint8Array(0), width: 8, height: 8 }), (error: unknown) => backgroundErrorCode(error) === 'background_image_unreadable');
    await assert.rejects(storeBackgroundImage(folder, { bytes: new Uint8Array([0, 0]), width: 8, height: 8 }), (error: unknown) => backgroundErrorCode(error) === 'background_image_unsupported');

    const manifest = { version: 1 as const, images: [] as Awaited<ReturnType<typeof listBackgroundImages>> };
    for (let index = 0; index < MAX_BACKGROUND_IMAGES; index += 1) {
      manifest.images.push({ id: String(index).padStart(64, 'a'), name: `n${index}`, width: 10, height: 10, bytes: 10, importedAt: new Date().toISOString(), stats, variants: {} });
    }
    await writeBackgroundManifest(folder, manifest);
    await assert.rejects(storeBackgroundImage(folder, { bytes: webpLossless(9, 9), width: 9, height: 9 }), (error: unknown) => backgroundErrorCode(error) === 'background_image_limit');

    const source = join(folder, 'huge.png');
    writeFileSync(source, Buffer.alloc(MAX_BACKGROUND_SOURCE_BYTES + 1));
    await assert.rejects(readBackgroundSource(source), (error: unknown) => backgroundErrorCode(error) === 'background_image_too_large');
    writeFileSync(source, pngHeader(8, 8));
    assert.equal((await readBackgroundSource(source)).mime, 'image/png');
    await assert.rejects(readBackgroundSource('relative/path.png'), (error: unknown) => backgroundErrorCode(error) === 'background_image_unreadable');
    await assert.rejects(readBackgroundSource(join(folder, 'missing.png')), (error: unknown) => backgroundErrorCode(error) === 'background_image_unreadable');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the QA picker override is ignored in packaged builds and for relative paths', () => {
  assert.equal(qaBackgroundPickOverride('C:\\pics\\a.png', false), 'C:\\pics\\a.png');
  assert.equal(qaBackgroundPickOverride('C:\\pics\\a.png', true), undefined);
  assert.equal(qaBackgroundPickOverride('pics/a.png', false), undefined);
  assert.equal(qaBackgroundPickOverride(undefined, false), undefined);
});

test('variants live under Cache and are recorded on the original', async () => {
  const folder = scratch();
  try {
    const record = await storeBackgroundImage(folder, { name: 'a.webp', bytes: webpLossless(3840, 2160), stats });
    const updated = await storeBackgroundVariant(folder, { id: record.id, blur: 8, bytes: webpLossless(1920, 1080), stats });
    assert.deepEqual(updated.variants['8'], { width: 1920, height: 1080, stats });
    const cache = backgroundFolders(folder).cache;
    assert.equal(statSync(join(cache, `${record.id}-b8.webp`)).isFile(), true);
    assert.equal((await listBackgroundImages(folder))[0].variants['8'].width, 1920);
    await assert.rejects(storeBackgroundVariant(folder, { id: 'a'.repeat(64), blur: 4, bytes: webpLossless(8, 8) }), (error: unknown) => backgroundErrorCode(error) === 'background_image_unreadable');
    await assert.rejects(storeBackgroundVariant(folder, { id: record.id, blur: 41, bytes: webpLossless(8, 8) }), (error: unknown) => backgroundErrorCode(error) === 'background_image_unreadable');
    await assert.rejects(storeBackgroundVariant(folder, { id: record.id, blur: 4, bytes: pngHeader(8, 8) }), (error: unknown) => backgroundErrorCode(error) === 'background_image_unsupported');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('remove and prune delete records, originals and baked variants', async () => {
  const folder = scratch();
  try {
    const first = await storeBackgroundImage(folder, { name: 'a.webp', bytes: webpLossless(100, 50), stats });
    const second = await storeBackgroundImage(folder, { name: 'b.webp', bytes: webpLossless(120, 60), stats });
    const third = await storeBackgroundImage(folder, { name: 'c.webp', bytes: webpLossless(140, 70), stats });
    await storeBackgroundVariant(folder, { id: first.id, blur: 6, bytes: webpLossless(96, 48), stats });
    await storeBackgroundVariant(folder, { id: second.id, blur: 6, bytes: webpLossless(96, 48), stats });

    await removeBackgroundImage(folder, first.id);
    assert.deepEqual((await listBackgroundImages(folder)).map(item => item.id), [second.id, third.id]);
    assert.equal(statIsMissing(join(backgroundFolders(folder).images, `${first.id}.webp`)), true);
    assert.equal(statIsMissing(join(backgroundFolders(folder).cache, `${first.id}-b6.webp`)), true);
    assert.equal(statIsMissing(join(backgroundFolders(folder).cache, `${second.id}-b6.webp`)), false, 'other variants stay');

    // An orphan file the manifest no longer knows about is cleaned up too.
    writeFileSync(join(backgroundFolders(folder).images, `${'b'.repeat(64)}.webp`), webpLossless(8, 8));
    writeFileSync(join(backgroundFolders(folder).cache, `${'b'.repeat(64)}-b6.webp`), webpLossless(8, 8));
    await pruneBackgroundImages(folder, [second.id]);
    assert.deepEqual((await listBackgroundImages(folder)).map(item => item.id), [second.id]);
    assert.equal(statIsMissing(join(backgroundFolders(folder).images, `${third.id}.webp`)), true);
    assert.equal(statIsMissing(join(backgroundFolders(folder).images, `${'b'.repeat(64)}.webp`)), true);
    assert.equal(statIsMissing(join(backgroundFolders(folder).cache, `${'b'.repeat(64)}-b6.webp`)), true);
    assert.equal(statIsMissing(join(backgroundFolders(folder).cache, `${second.id}-b6.webp`)), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the protocol URL grammar accepts only the two served shapes', () => {
  const id = 'a'.repeat(64);
  const upper = 'A'.repeat(64);
  assert.deepEqual(parseBackgroundUrl(`${BACKGROUND_IMAGE_SCHEME}://image/${id}`), { id });
  assert.deepEqual(parseBackgroundUrl(`${BACKGROUND_IMAGE_SCHEME}://image/${id}/b40`), { id, blur: 40 });
  assert.deepEqual(parseBackgroundUrl(`${BACKGROUND_IMAGE_SCHEME}://image/${id}/b1`), { id, blur: 1 });
  for (const rejected of [
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}/b0`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}/b41`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}/b-1`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}/b06`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}/x8`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}/b8/extra`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${upper}`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id.slice(1)}`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}0`,
    `${BACKGROUND_IMAGE_SCHEME}://image/../${id}`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}/../../etc/passwd`,
    `${BACKGROUND_IMAGE_SCHEME}://image/%2e%2e%2f${id}`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}%2f..%2f..%2fpasswd`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}\\..\\passwd`,
    `${BACKGROUND_IMAGE_SCHEME}://other/${id}`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}?x=1`,
    `${BACKGROUND_IMAGE_SCHEME}://image/${id}#x`,
    `${BACKGROUND_IMAGE_SCHEME}://user:pass@image/${id}`,
    `${BACKGROUND_IMAGE_SCHEME}://image/`,
    'https://example.com/image/' + id,
    'file:///' + id,
    '',
  ]) assert.equal(parseBackgroundUrl(rejected), undefined, `rejected: ${rejected}`);
  assert.equal(parseBackgroundUrl(undefined), undefined);
  assert.equal(parseBackgroundUrl('not a url'), undefined);
});

test('a parsed request maps to the served file, and the URL of a record round-trips', () => {
  const folder = join(tmpdir(), 'tt-background-map');
  const id = 'c'.repeat(64);
  assert.equal(backgroundRequestPath(folder, { id }), join(folder, `${id}.webp`));
  assert.equal(backgroundRequestPath(folder, { id, blur: 12 }), join(folder, 'Cache', `${id}-b12.webp`));
  assert.equal(parseBackgroundUrl(backgroundImageUrl(id))?.id, id);
  assert.equal(parseBackgroundUrl(backgroundImageUrl(id, 12))?.blur, 12);
});

test('an error keeps its code both directly and after Electron flattens it', () => {
  const direct = new BackgroundImageError('background_image_too_large', '41 bytes');
  assert.equal(backgroundErrorCode(direct), 'background_image_too_large');
  assert.equal(backgroundErrorCode(new Error("Error invoking remote method 'threadterm:background-store': Error: background_image_limit: 100 images")), 'background_image_limit');
  assert.equal(backgroundErrorCode(new Error('something else')), undefined);
  assert.equal(backgroundErrorCode('background_image_limit'), undefined);
  assert.match(direct.message, /^background_image_too_large: 41 bytes$/);
});

test('the store folder is created on demand and never outside the profile', async () => {
  const folder = scratch();
  try {
    mkdirSync(join(folder, 'profile'));
    const nested = join(folder, 'profile', 'backgrounds');
    await storeBackgroundImage(nested, { bytes: webpLossless(10, 10), width: 10, height: 10, stats });
    assert.equal(backgroundFolders(nested).root, nested);
    assert.equal(statSync(join(nested, 'manifest.json')).isFile(), true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
