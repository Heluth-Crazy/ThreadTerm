// Background image pipeline (task 10-26 phase D): import, downscale, re-encode and blur-bake pictures with Chromium's
// own decoders, and wrap the desktop's `threadterm-bg:`/IPC bridge.
//
// Decoding happens once per import and once per (image, blur) bake — never per frame: a blurred background is a stored
// WebP variant, not a live CSS filter. Statistics are the mockup's worst pixels (darkest and brightest 4 %), so the
// readability floor in `readability.ts` can be computed without the picture.
import type { BackgroundBridge, BackgroundRecord, ImageStats, Rgb } from '../../../desktop/src/backgroundImagesCore';
import { relativeLuminance } from './readability';

/** The prepared original: long edge ≤ 3840 px, WebP at quality 0.9 (or lower to fit the store's byte cap). */
export const MAX_PREPARED_EDGE = 3840;
/** A baked blur variant needs no detail: long edge ≤ 1920 px. */
export const MAX_BAKED_EDGE = 1920;
/** The blur value is CSS px at a 1920-px-wide rendering (must match desktop/src/backgroundImagesCore.ts). */
export const MAX_BLUR = 40;
/** Must match MAX_BACKGROUND_STORED_BYTES in desktop/src/backgroundImagesCore.ts. */
const MAX_STORED_BYTES = 16 * 1024 * 1024;
const STATS_EDGE = 200;
const STATS_TAIL = 0.04;
const STATS_KEEP = 48;

export interface PreparedBackground { bytes: Uint8Array; mime: 'image/webp'; width: number; height: number; stats: ImageStats }

/** The URL the app serves a stored image (or one baked blur variant) from. Desktop/src/backgroundImagesCore.ts parses it. */
export function backgroundImageUrl(id: string, blur?: number): string {
  return `threadterm-bg://image/${id}${blur === undefined ? '' : `/b${blur}`}`;
}

type BackgroundFacade = typeof window.threadterm & Partial<BackgroundBridge>;

function facade(): BackgroundFacade {
  const value = (window as unknown as { threadterm?: BackgroundFacade }).threadterm;
  if (!value || typeof value.storeBackgroundImage !== 'function') throw codedError('background_image_unreadable', 'background images require the desktop application');
  return value;
}

/** An error a caller can translate: `error.code`, and the code also leads the message (it survives IPC). */
function codedError(code: string, detail: string): Error {
  const error = new Error(`${code}: ${detail}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

// ------------------------------------------------------------------ statistics

/** The darkest and brightest pixels of an image, reduced to ≤ 48 representative colours each. */
export function imageStatistics(pixels: ArrayLike<number>): ImageStats {
  const entries: Array<{ color: Rgb; luminance: number }> = [];
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    // A fully transparent pixel contributes nothing to the surface behind the picture.
    if (pixels[index + 3] < 8) continue;
    const color: Rgb = [pixels[index], pixels[index + 1], pixels[index + 2]];
    entries.push({ color, luminance: relativeLuminance(color) });
  }
  if (entries.length === 0) return { dark: [], bright: [] };
  entries.sort((left, right) => left.luminance - right.luminance);
  const count = Math.max(1, Math.ceil(entries.length * STATS_TAIL));
  return {
    dark: representativeColors(entries.slice(0, count), 'dark'),
    bright: representativeColors(entries.slice(-count), 'bright'),
  };
}

/** Quantises to 4 bits per channel, averages each bucket, then keeps the most extreme colours by luminance. */
function representativeColors(entries: readonly { color: Rgb; luminance: number }[], edge: 'dark' | 'bright'): Rgb[] {
  const buckets = new Map<number, { sum: Rgb; count: number }>();
  for (const entry of entries) {
    const key = ((entry.color[0] >> 4) << 8) | ((entry.color[1] >> 4) << 4) | (entry.color[2] >> 4);
    const bucket = buckets.get(key);
    if (bucket) { bucket.sum[0] += entry.color[0]; bucket.sum[1] += entry.color[1]; bucket.sum[2] += entry.color[2]; bucket.count += 1; }
    else buckets.set(key, { sum: [...entry.color] as Rgb, count: 1 });
  }
  const colors = [...buckets.values()].map(bucket => {
    const color: Rgb = [Math.round(bucket.sum[0] / bucket.count), Math.round(bucket.sum[1] / bucket.count), Math.round(bucket.sum[2] / bucket.count)];
    return { color, luminance: relativeLuminance(color) };
  }).sort((left, right) => left.luminance - right.luminance);
  const kept = edge === 'dark' ? colors.slice(0, STATS_KEEP) : colors.slice(-STATS_KEEP);
  return kept.map(item => item.color);
}

function statisticsFromSource(source: ImageBitmap | OffscreenCanvas): ImageStats {
  const long = Math.max(source.width, source.height);
  const scale = Math.min(1, STATS_EDGE / long);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw codedError('background_image_unreadable', 'no 2d context');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return imageStatistics(context.getImageData(0, 0, width, height).data);
}

// ------------------------------------------------------------------ decoding and encoding

async function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }), { imageOrientation: 'from-image' }); }
  catch (error) { throw codedError('background_image_unreadable', (error as Error).message); }
  if (!bitmap.width || !bitmap.height) { bitmap.close(); throw codedError('background_image_unreadable', 'empty image'); }
  return bitmap;
}

/** High-quality downscale so the long edge is at most `maxEdge`; returns the bitmap to release and the result. */
async function downscale(bitmap: ImageBitmap, maxEdge: number): Promise<{ bitmap: ImageBitmap; release: ImageBitmap }> {
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= maxEdge) return { bitmap, release: bitmap };
  const scale = maxEdge / long;
  const resized = await createImageBitmap(bitmap, {
    resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
    resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
    resizeQuality: 'high',
  });
  return { bitmap: resized, release: bitmap };
}

async function encodeWebp(canvas: OffscreenCanvas, quality: number): Promise<Blob> {
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  if (!blob || blob.type !== 'image/webp' || blob.size === 0) throw codedError('background_image_unsupported', 'WebP encoding failed');
  return blob;
}

/** Re-encodes at falling quality until the blob fits the store's byte cap. */
async function encodeWithinCap(canvas: OffscreenCanvas, quality: number): Promise<Blob> {
  let blob = await encodeWebp(canvas, quality);
  for (const next of [quality - 0.1, quality - 0.2, quality - 0.3, 0.4]) {
    if (blob.size <= MAX_STORED_BYTES) return blob;
    if (next <= 0) break;
    blob = await encodeWebp(canvas, Math.min(quality, next));
  }
  if (blob.size > MAX_STORED_BYTES) throw codedError('background_image_too_large', `${blob.size} bytes`);
  return blob;
}

function drawToCanvas(bitmap: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw codedError('background_image_unreadable', 'no 2d context');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0);
  return canvas;
}

// ------------------------------------------------------------------ import

/** Decodes, downscales to ≤ 3840 px and re-encodes one source file as WebP, with its statistics. */
export async function prepareBackgroundImage(bytes: Uint8Array, mime: string): Promise<PreparedBackground> {
  const decoded = await decodeImage(bytes, mime);
  const { bitmap, release } = await downscale(decoded, MAX_PREPARED_EDGE);
  try {
    const canvas = drawToCanvas(bitmap);
    const stats = statisticsFromSource(bitmap);
    const blob = await encodeWithinCap(canvas, 0.9);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp', width: bitmap.width, height: bitmap.height, stats };
  } finally {
    if (release !== decoded) decoded.close();
    bitmap.close();
  }
}

/** Prepares and stores bytes that did not come from the picker (a drop, a theme pack). */
export async function importBackgroundFromBytes(bytes: Uint8Array, mime: string, name: string): Promise<BackgroundRecord> {
  const prepared = await prepareBackgroundImage(bytes, mime);
  return facade().storeBackgroundImage!({ name, ...prepared });
}

/** Opens the native picker and stores the chosen picture; null when the user cancels. */
export async function importBackgroundFromPicker(): Promise<BackgroundRecord | null> {
  const picked = await facade().pickBackgroundImage!();
  if (!picked) return null;
  return importBackgroundFromBytes(picked.bytes, picked.mime, picked.name);
}

/** Imports a dropped file by path (the renderer never reads the file itself). */
export async function importBackgroundFromPath(path: string): Promise<BackgroundRecord> {
  const source = await facade().readBackgroundSource!(path);
  return importBackgroundFromBytes(source.bytes, source.mime, source.name);
}

// ------------------------------------------------------------------ blur variants

/** The served original, decoded for a bake. The request is CORS-mode so the canvas stays readable for statistics. */
async function servedBitmap(id: string): Promise<ImageBitmap> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = backgroundImageUrl(id);
  try { await image.decode(); }
  catch (error) { throw codedError('background_image_unreadable', `could not load ${id}: ${(error as Error).message}`); }
  return createImageBitmap(image);
}

/**
 * Bakes one blur variant: the picture is scaled up by the blur padding before it is blurred, so the edges keep their
 * colour instead of fading into the canvas (the mockup's `bakedURL`).
 */
export async function bakeBlurVariant(
  source: { bytes: Uint8Array; mime?: string } | { id: string },
  blur: number,
): Promise<PreparedBackground> {
  if (!Number.isInteger(blur) || blur < 1 || blur > MAX_BLUR) throw codedError('background_image_unreadable', `invalid blur ${blur}`);
  const decoded = 'bytes' in source ? await decodeImage(source.bytes, source.mime ?? 'image/webp') : await servedBitmap(source.id);
  const { bitmap, release } = await downscale(decoded, MAX_BAKED_EDGE);
  try {
    const blurPx = Math.max(0.5, (blur * Math.max(bitmap.width, bitmap.height)) / MAX_BAKED_EDGE);
    const pad = Math.ceil(blurPx * 3);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw codedError('background_image_unreadable', 'no 2d context');
    context.imageSmoothingQuality = 'high';
    context.filter = `blur(${blurPx}px)`;
    context.drawImage(bitmap, -pad, -pad, bitmap.width + pad * 2, bitmap.height + pad * 2);
    const stats = statisticsFromSource(canvas);
    const blob = await encodeWithinCap(canvas, 0.85);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp', width: bitmap.width, height: bitmap.height, stats };
  } finally {
    if (release !== decoded) decoded.close();
    bitmap.close();
  }
}

/** Bakes and stores the variant the manifest does not have yet, then returns the updated record. */
export async function ensureBlurVariant(record: BackgroundRecord, blur: number): Promise<BackgroundRecord> {
  if (record.variants[String(blur)]) return record;
  const baked = await bakeBlurVariant({ id: record.id }, blur);
  return facade().storeBackgroundVariant!({ id: record.id, blur, ...baked });
}

// ------------------------------------------------------------------ store access

export async function listBackgroundImages(): Promise<BackgroundRecord[]> {
  return facade().listBackgroundImages!();
}

export async function removeBackgroundImage(id: string): Promise<void> {
  return facade().removeBackgroundImage!(id);
}

/** Deletes every stored picture whose id is not in `keepIds` (used when themes are pruned or imported). */
export async function pruneBackgroundImages(keepIds: readonly string[]): Promise<void> {
  return facade().pruneBackgroundImages!([...keepIds]);
}
