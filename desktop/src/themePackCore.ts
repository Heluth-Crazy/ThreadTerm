// Theme export/import with background images (task 10-26 phase D): the pack format and the two operations the theme
// export handler and its IPC need.
//
// Node-only and Electron-free, so the rules stay unit-testable without an Electron process:
//
//   { "threadtermThemePack": 2, "themes": { "<name>": ThemeTokens }, "images": { "<id>": { "name", "webp" } } }
//
// A theme selection without any backgrounds is still exported as today's plain `customThemes` object, so old files stay
// byte-compatible. All image rules (WebP magic, dimensions, caps, sha256 id) come from backgroundImagesCore.ts.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  backgroundFolders,
  backgroundImageFileName,
  MAX_BACKGROUND_EDGE,
  MAX_BACKGROUND_STORED_BYTES,
  readBackgroundManifest,
  sniffImageBytes,
  storeBackgroundImage,
  webpDimensions,
  type BackgroundRecord,
} from './backgroundImagesCore.js';

export const THEME_PACK_VERSION = 2;
/** Pictures together may not exceed this many bytes in one export. */
export const MAX_THEME_PACK_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACK_IMAGES = 1000;

export type ThemePackErrorCode = 'theme_pack_too_large' | 'theme_pack_unreadable';

/** Carries a translatable code; the message starts with it so it survives Electron's IPC error flattening. */
export class ThemePackError extends Error {
  readonly code: ThemePackErrorCode;
  constructor(code: ThemePackErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ThemePackError';
    this.code = code;
  }
}

const imageId = /^[a-f0-9]{64}$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Every stored image id the custom themes name (a layer whose shape is off is ignored, never trusted as a path). */
export function themeBackgroundImageIds(themes: unknown): string[] {
  const ids = new Set<string>();
  if (!isObject(themes)) return [];
  for (const tokens of Object.values(themes)) {
    if (!isObject(tokens) || !isObject(tokens.backgrounds)) continue;
    for (const layer of Object.values(tokens.backgrounds)) {
      if (isObject(layer) && typeof layer.image === 'string' && imageId.test(layer.image)) ids.add(layer.image);
    }
  }
  return [...ids];
}

export interface ThemeExport {
  /** The object written to the file: plain themes, or the version 2 pack when any theme has backgrounds. */
  pack: unknown;
  /** Image ids embedded in the pack. */
  images: string[];
  /** Image ids a theme names but the store no longer has (the theme keeps the id, the picture is skipped). */
  missing: string[];
}

const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * Builds the exported content for a collection of custom themes: embeds every referenced picture as base64 when the
 * themes carry backgrounds, and keeps today's plain object otherwise. Missing files are skipped and reported.
 */
export async function buildThemeExport(folder: string, themes: unknown, options: { maxImageBytes?: number } = {}): Promise<ThemeExport> {
  const ids = themeBackgroundImageIds(themes);
  if (ids.length === 0) return { pack: themes, images: [], missing: [] };
  const limit = Math.max(1, options.maxImageBytes ?? MAX_THEME_PACK_IMAGE_BYTES);
  const folders = backgroundFolders(folder);
  const manifest = await readBackgroundManifest(folder);
  const images: Record<string, { name: string; webp: string }> = {};
  const missing: string[] = [];
  let total = 0;
  for (const id of ids) {
    const record = manifest.images.find(image => image.id === id);
    if (!record) { missing.push(id); continue; }
    let bytes: Buffer;
    try { bytes = await fs.readFile(join(folders.images, backgroundImageFileName(id))); }
    catch { missing.push(id); continue; }
    total += bytes.length;
    if (total > limit) throw new ThemePackError('theme_pack_too_large', `${total} bytes`);
    images[id] = { name: record.name, webp: encodeBase64(bytes) };
  }
  const pack = Object.keys(images).length > 0
    ? { threadtermThemePack: THEME_PACK_VERSION, themes, images }
    : themes;
  return { pack, images: Object.keys(images), missing };
}

export interface PackImageInput { id?: unknown; name?: unknown; webp?: unknown; stats?: unknown }

/**
 * Validates and stores the pictures of an imported pack. An image is refused (skipped, not fatal) when its id is not a
 * sha256, is not the hash of its own bytes, is not a WebP, or breaks a store cap; identical bytes dedupe to one record.
 */
export async function importThemePackImages(folder: string, images: unknown): Promise<BackgroundRecord[]> {
  if (!Array.isArray(images) || images.length > MAX_PACK_IMAGES) throw new ThemePackError('theme_pack_unreadable', 'invalid image list');
  const stored: BackgroundRecord[] = [];
  for (const entry of images) {
    if (!isObject(entry)) continue;
    const input = entry as PackImageInput;
    if (typeof input.id !== 'string' || !imageId.test(input.id)) continue;
    if (typeof input.webp !== 'string' || input.webp.length === 0) continue;
    if (input.webp.length % 4 !== 0 || !base64.test(input.webp)) continue;
    const bytes = Buffer.from(input.webp, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_BACKGROUND_STORED_BYTES) continue;
    if (createHash('sha256').update(bytes).digest('hex') !== input.id) continue;
    const sniffed = sniffImageBytes(bytes);
    if (!sniffed.ok || sniffed.format !== 'webp') continue;
    const measured = webpDimensions(bytes);
    if (!measured || measured.width > MAX_BACKGROUND_EDGE || measured.height > MAX_BACKGROUND_EDGE) continue;
    const name = typeof input.name === 'string' ? input.name : 'background.webp';
    try {
      stored.push(await storeBackgroundImage(folder, { name, bytes: new Uint8Array(bytes), width: measured.width, height: measured.height, stats: input.stats }));
    } catch { /* store caps (image count, bytes) skip this picture only */ }
  }
  return stored;
}

/** QA points the export at a fixture path instead of the native save dialog; ignored in packaged builds. */
export function qaThemeExportOverride(envValue: string | undefined, isPackaged: boolean): string | undefined {
  if (isPackaged || !envValue || envValue.length > 4096 || !isAbsolute(envValue)) return undefined;
  return envValue;
}
