// Theme packs (task 10-26 phase D): the export/import file format for custom themes with background images.
//
// Today's export is the plain `customThemes` object; a theme that carries backgrounds would lose its pictures, so a
// pack with backgrounds is `{ threadtermThemePack: 2, themes, images: { "<id>": { name, webp } } }`. The old plain
// format still parses, and a pack without backgrounds is still written as plain JSON by the desktop.
//
// Parsing is pure and DOM-free; importing decodes each picture once for its readability statistics and asks the
// desktop to validate and store it (hash, WebP magic, caps) under the id the pack names.
import type { BackgroundRecord, ImageStats } from '../../../desktop/src/backgroundImagesCore';
import { customTokens, inheritBackgroundImage, maxBackgroundBlur, type ThemeTokens } from '../themes';
import { imageStatistics } from './backgroundPipeline';
import { referencedImageIds } from './backgrounds';

/** The marker that makes a file a pack; a file without it is the plain `customThemes` map. */
export const THEME_PACK_VERSION = 2;
/** Pack images together may not exceed this many bytes before base64 (the desktop refuses a larger export too). */
export const MAX_THEME_PACK_IMAGE_BYTES = 64 * 1024 * 1024;
/** Must match MAX_BACKGROUND_STORED_BYTES in desktop/src/backgroundImagesCore.ts. */
export const MAX_PACK_IMAGE_BYTES = 16 * 1024 * 1024;
const STATS_EDGE = 200;

export type ThemePackErrorCode =
  | 'theme_pack_unreadable'
  | 'theme_pack_empty'
  | 'theme_pack_invalid_theme'
  | 'theme_pack_invalid_image'
  | 'theme_pack_too_large';

export class ThemePackError extends Error {
  readonly code: ThemePackErrorCode;
  constructor(code: ThemePackErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ThemePackError';
    this.code = code;
  }
}

const errorCodes: readonly ThemePackErrorCode[] = [
  'theme_pack_unreadable',
  'theme_pack_empty',
  'theme_pack_invalid_theme',
  'theme_pack_invalid_image',
  'theme_pack_too_large',
];

/** The code for a failure, whether it came from this module or through `ipcRenderer.invoke`. */
export function themePackErrorCode(error: unknown): ThemePackErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string' && (errorCodes as readonly string[]).includes(direct)) return direct as ThemePackErrorCode;
  const text = (error as { message?: unknown }).message;
  if (typeof text !== 'string') return undefined;
  return errorCodes.find(code => text.includes(code));
}

/** One picture of a pack, decoded: the manifest name and the stored WebP bytes. */
export interface PackImage { name: string; bytes: Uint8Array }
export type PackImages = Record<string, PackImage>;

export interface ParsedThemePack {
  /** 1 = today's plain `customThemes` JSON, 2 = the pack with embedded pictures. */
  version: 1 | 2;
  themes: Record<string, ThemeTokens>;
  /** By image id: the pack's pictures, decoded. */
  images: PackImages;
  /** Image ids some theme names but the pack does not carry (it may still exist in this profile's store). */
  missing: string[];
}

const imageId = /^[a-f0-9]{64}$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(text: string): Uint8Array | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !base64.test(text)) return undefined;
  let binary: string;
  try { binary = atob(text); }
  catch { return undefined; }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Standard base64 with padding, in 32 kB slices (a `String.fromCharCode(...bytes)` spread overflows the stack). */
export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function themeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}

/** Validates one theme entry; throws `theme_pack_invalid_theme` (an import must not silently invent a palette). */
function packTheme(name: string, value: unknown): ThemeTokens {
  const tokens = customTokens(value);
  if (!tokens) throw new ThemePackError('theme_pack_invalid_theme', name);
  return tokens;
}

/**
 * Parses a pack or a plain theme map. Version 2 embeds pictures; anything else must be today's plain object (either a
 * `{ name, colors }` single theme or a map of name → colours). Throws a `ThemePackError` with a translatable code.
 */
export function parseThemePack(input: string | unknown, options: { maxImageBytes?: number } = {}): ParsedThemePack {
  let value = input;
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '').trim();
    if (!text) throw new ThemePackError('theme_pack_unreadable', 'empty file');
    try { value = JSON.parse(text); }
    catch { throw new ThemePackError('theme_pack_unreadable', 'invalid JSON'); }
  }
  if (!isObject(value)) throw new ThemePackError('theme_pack_unreadable', 'not a theme object');
  if ('threadtermThemePack' in value) {
    if (value.threadtermThemePack !== THEME_PACK_VERSION) throw new ThemePackError('theme_pack_unreadable', 'unsupported pack version');
    return parsePackV2(value, options);
  }
  return parsePlainThemes(value);
}

function parsePackV2(pack: Record<string, unknown>, options: { maxImageBytes?: number }): ParsedThemePack {
  const source = pack.themes;
  if (!isObject(source)) throw new ThemePackError('theme_pack_unreadable', 'missing themes');
  const themes = parseThemeMap(source);
  const images: PackImages = {};
  const limit = Math.max(1, options.maxImageBytes ?? MAX_THEME_PACK_IMAGE_BYTES);
  let total = 0;
  const raw = pack.images === undefined ? {} : pack.images;
  if (!isObject(raw)) throw new ThemePackError('theme_pack_unreadable', 'invalid images');
  for (const [id, entry] of Object.entries(raw)) {
    if (!imageId.test(id)) throw new ThemePackError('theme_pack_invalid_image', id);
    if (!isObject(entry)) throw new ThemePackError('theme_pack_invalid_image', id);
    const bytes = decodeBase64(typeof entry.webp === 'string' ? entry.webp : '');
    if (!bytes || bytes.length === 0) throw new ThemePackError('theme_pack_invalid_image', id);
    if (bytes.length > MAX_PACK_IMAGE_BYTES) throw new ThemePackError('theme_pack_invalid_image', id);
    total += bytes.length;
    if (total > limit) throw new ThemePackError('theme_pack_too_large', `${total} bytes`);
    const name = themeName(entry.name) ?? 'background.webp';
    images[id] = { name, bytes };
  }
  const missing = [...referencedImageIds(themes)].filter(id => !images[id]);
  return { version: THEME_PACK_VERSION, themes, images, missing };
}

function parsePlainThemes(source: Record<string, unknown>): ParsedThemePack {
  // Today's import also accepts one `{ name, colors }` theme object.
  const entries: Array<[string, unknown]> = typeof source.name === 'string'
    ? [[source.name, isObject(source.colors) ? source.colors : source]]
    : Object.entries(source);
  const themes = parseThemeMap(Object.fromEntries(entries));
  return { version: 1, themes, images: {}, missing: [] };
}

function parseThemeMap(source: Record<string, unknown>): Record<string, ThemeTokens> {
  const themes: Record<string, ThemeTokens> = {};
  for (const [rawName, tokens] of Object.entries(source)) {
    const name = themeName(rawName);
    if (!name) throw new ThemePackError('theme_pack_invalid_theme', rawName);
    themes[name] = packTheme(name, tokens);
  }
  if (Object.keys(themes).length === 0) throw new ThemePackError('theme_pack_empty');
  return themes;
}

/** The custom theme names a plain export or a pack carries, in file order. */
export function exportedThemeNames(themes: unknown): string[] {
  if (!isObject(themes)) return [];
  return Object.keys(themes).filter(name => themeName(name) !== undefined);
}

// ------------------------------------------------------------------ importing

/** The desktop method that validates and stores pack pictures (desktop/src/preload.ts). */
interface ThemePackBridge {
  importThemePackImages(images: Array<{ id: string; name: string; webp: string; stats?: ImageStats }>): Promise<BackgroundRecord[]>;
}

function bridge(): ThemePackBridge {
  const value = (window as unknown as { threadterm?: ThemePackBridge }).threadterm;
  if (!value || typeof value.importThemePackImages !== 'function') throw new ThemePackError('theme_pack_unreadable', 'theme packs with pictures require the desktop application');
  return value;
}

/** Decodes one picture once for its readability statistics (the pack carries bytes, not statistics). */
async function statistics(bytes: Uint8Array): Promise<ImageStats | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }));
    const scale = Math.min(1, STATS_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return imageStatistics(context.getImageData(0, 0, width, height).data);
  } catch { return undefined; }
}

export interface StoredPackImages { records: BackgroundRecord[]; rejected: string[] }

/** Validates and stores a pack's pictures; `rejected` lists the ids the desktop refused (hash, format, caps). */
export async function storePackImages(images: PackImages): Promise<StoredPackImages> {
  const ids = Object.keys(images);
  if (ids.length === 0) return { records: [], rejected: [] };
  const payload: Array<{ id: string; name: string; webp: string; stats?: ImageStats }> = [];
  for (const id of ids) {
    const image = images[id];
    payload.push({ id, name: image.name, webp: encodeBase64(image.bytes), stats: await statistics(image.bytes) });
  }
  const records = await bridge().importThemePackImages(payload);
  const stored = new Set(records.map(record => record.id));
  return { records, rejected: ids.filter(id => !stored.has(id)) };
}

export interface ImportedThemePack extends ParsedThemePack {
  records: BackgroundRecord[];
  rejected: string[];
}

/** Parses a pack and stores its pictures: the whole import in one call for the settings UI. */
export async function importThemePack(input: string | unknown, options: { maxImageBytes?: number } = {}): Promise<ImportedThemePack> {
  const parsed = parseThemePack(input, options);
  const { records, rejected } = await storePackImages(parsed.images);
  return { ...parsed, records, rejected };
}

/** The blur values a pack's themes ask for (so the UI can bake the missing variants once, before rendering). A layer that
 * shows the window picture has no picture of its own, so its blur is ignored. */
export function requestedBlurs(themes: Record<string, ThemeTokens>): number[] {
  const blurs = new Set<number>();
  for (const theme of Object.values(themes)) {
    for (const layer of Object.values(theme.backgrounds ?? {})) {
      if (!layer || layer.image === inheritBackgroundImage) continue;
      if (layer.blur > 0 && layer.blur <= maxBackgroundBlur) blurs.add(layer.blur);
    }
  }
  return [...blurs].sort((left, right) => left - right);
}
