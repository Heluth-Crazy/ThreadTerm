// Background images (task 10-26 phase D): magic-byte sniffing, size caps, the on-disk manifest, the id/folder mapping
// and the `threadterm-bg:` URL grammar.
//
// Node-only and Electron-free, so every rule here is unit-testable and the Electron glue
// (desktop/src/backgroundImages.ts) stays a thin layer over it. Layout under the desktop profile:
//
//   <profile>/backgrounds/<id>.webp                 originals (backed up)
//   <profile>/backgrounds/manifest.json             records + image statistics
//   <profile>/backgrounds/Cache/<id>-b<blur>.webp   baked blur variants (rebuildable, skipped by backups)
//
// `id` is the lowercase sha256 hex of the stored bytes, so re-importing the same picture dedupes.
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export type Rgb = [number, number, number];
/** The image's worst pixels (darkest and brightest by WCAG luminance), reduced to representative colours. */
export interface ImageStats { dark: Rgb[]; bright: Rgb[] }
export interface BackgroundVariant { width: number; height: number; stats: ImageStats }
export interface BackgroundRecord {
  id: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  importedAt: string;
  stats: ImageStats;
  /** Keyed by the integer blur value. */
  variants: Record<string, BackgroundVariant>;
}
export interface BackgroundManifest { version: 1; images: BackgroundRecord[] }

export const BACKGROUND_IMAGE_SCHEME = 'threadterm-bg';
/** A picked/dropped source file; the pipeline downscales and re-encodes it well below this. */
export const MAX_BACKGROUND_SOURCE_BYTES = 40 * 1024 * 1024;
/** A stored (WebP) original: the pipeline re-encodes until it fits. */
export const MAX_BACKGROUND_STORED_BYTES = 16 * 1024 * 1024;
export const MAX_BACKGROUND_IMAGES = 100;
/** 4K: a background never needs more, and the renderer decodes it once per import. */
export const MAX_BACKGROUND_EDGE = 3840;
export const MAX_BACKGROUND_BLUR = 40;

export type BackgroundErrorCode =
  | 'background_image_unsupported'
  | 'background_image_too_large'
  | 'background_image_limit'
  | 'background_image_unreadable';

/** Carries a translatable code; the message starts with it so it survives Electron's IPC error flattening. */
export class BackgroundImageError extends Error {
  readonly code: BackgroundErrorCode;
  constructor(code: BackgroundErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BackgroundImageError';
    this.code = code;
  }
}

const errorCodes: readonly BackgroundErrorCode[] = [
  'background_image_unsupported',
  'background_image_too_large',
  'background_image_limit',
  'background_image_unreadable',
];

/** The code for a failure, whether it came from this process or through `ipcRenderer.invoke`. */
export function backgroundErrorCode(error: unknown): BackgroundErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string' && (errorCodes as readonly string[]).includes(direct)) return direct as BackgroundErrorCode;
  const text = (error as { message?: unknown }).message;
  if (typeof text !== 'string') return undefined;
  return errorCodes.find(code => text.includes(code));
}

export interface BackgroundFolders { root: string; images: string; cache: string; manifest: string }

/** The folders of the store rooted at `<profile>/backgrounds` (or any folder a test passes). */
export function backgroundFolders(folder: string): BackgroundFolders {
  const root = folder.endsWith('/') || folder.endsWith('\\') ? folder.slice(0, -1) : folder;
  return { root, images: root, cache: join(root, 'Cache'), manifest: join(root, 'manifest.json') };
}

export const backgroundImageFileName = (id: string) => `${id}.webp`;
export const backgroundVariantFileName = (id: string, blur: number) => `${id}-b${blur}.webp`;

// ---------------------------------------------------------------- magic bytes

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'bmp';
export type SniffResult =
  | { ok: true; format: ImageFormat; mime: string }
  | { ok: false; reason: 'gif' | 'svg' | 'text' | 'unknown' };

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
export const imageFormatMime = (format: ImageFormat): string => MIME[format];

const startsWith = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
};
const printable = (value: number) => value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126);

/** The container type from the first bytes of a file — never from its extension. */
export function sniffImageBytes(bytes: Uint8Array): SniffResult {
  if (bytes.length >= 8 && startsWith(bytes, 0, '\x89PNG\r\n\x1a\n')) return { ok: true, format: 'png', mime: MIME.png };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ok: true, format: 'jpeg', mime: MIME.jpeg };
  if (bytes.length >= 12 && startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP')) return { ok: true, format: 'webp', mime: MIME.webp };
  if (bytes.length >= 14 && startsWith(bytes, 0, 'BM') && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0) return { ok: true, format: 'bmp', mime: MIME.bmp };
  if (bytes.length >= 12 && startsWith(bytes, 4, 'ftyp') && isAvifBrand(bytes)) return { ok: true, format: 'avif', mime: MIME.avif };
  // Animated pictures are named explicitly so the UI can say why instead of "unreadable".
  if (bytes.length >= 6 && (startsWith(bytes, 0, 'GIF87a') || startsWith(bytes, 0, 'GIF89a'))) return { ok: false, reason: 'gif' };
  const head = decodeHead(bytes);
  if (/^\s*(?:<\?xml|<!doctype\s+svg|<svg)/i.test(head) && /<svg/i.test(head)) return { ok: false, reason: 'svg' };
  const sampled = Math.min(bytes.length, 512);
  if (sampled > 0) {
    let text = 0;
    for (let index = 0; index < sampled; index += 1) if (printable(bytes[index])) text += 1;
    if (text / sampled > 0.95) return { ok: false, reason: 'text' };
  }
  return { ok: false, reason: 'unknown' };
}

function isAvifBrand(bytes: Uint8Array): boolean {
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, size >= 16 ? size : bytes.length);
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    if (startsWith(bytes, offset, 'avif') || startsWith(bytes, offset, 'avis')) return true;
  }
  return false;
}

function decodeHead(bytes: Uint8Array): string {
  let head = '';
  for (let index = 0; index < Math.min(bytes.length, 1024); index += 1) head += String.fromCharCode(bytes[index]);
  return head;
}

// ---------------------------------------------------------------- WebP geometry

/** Canvas size from a WebP header (VP8X, VP8 lossy or VP8L lossless); undefined when the file is not a WebP. */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!(bytes.length >= 30) || !startsWith(bytes, 0, 'RIFF') || !startsWith(bytes, 8, 'WEBP')) return undefined;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  const readUInt24 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  if (chunk === 'VP8X') return { width: readUInt24(24) + 1, height: readUInt24(27) + 1 };
  if (chunk === 'VP8 ') {
    // Keyframe: 3-byte frame tag, then the 3-byte start code, then 14-bit width and height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

// ---------------------------------------------------------------- manifest

const emptyManifest = (): BackgroundManifest => ({ version: 1, images: [] });

const isRgb = (value: unknown): value is Rgb => Array.isArray(value) && value.length === 3
  && value.every(channel => Number.isInteger(channel) && Number(channel) >= 0 && Number(channel) <= 255);

function sanitizeStats(value: unknown): ImageStats | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { dark?: unknown; bright?: unknown };
  if (!Array.isArray(record.dark) || !Array.isArray(record.bright)) return undefined;
  const dark = record.dark.filter(isRgb).slice(0, 48);
  const bright = record.bright.filter(isRgb).slice(0, 48);
  return { dark, bright };
}

const validBackgroundId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function sanitizeVariant(value: unknown): BackgroundVariant | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { width?: unknown; height?: unknown; stats?: unknown };
  const stats = sanitizeStats(record.stats);
  if (!stats) return undefined;
  if (!Number.isInteger(record.width) || !Number.isInteger(record.height)) return undefined;
  const width = Number(record.width), height = Number(record.height);
  if (width < 1 || height < 1 || width > MAX_BACKGROUND_EDGE || height > MAX_BACKGROUND_EDGE) return undefined;
  return { width, height, stats };
}

function sanitizeRecord(value: unknown): BackgroundRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (!validBackgroundId(record.id)) return undefined;
  const stats = sanitizeStats(record.stats);
  if (!stats) return undefined;
  const { width, height, bytes } = record;
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(bytes)) return undefined;
  if (Number(width) < 1 || Number(height) < 1 || Number(width) > MAX_BACKGROUND_EDGE || Number(height) > MAX_BACKGROUND_EDGE) return undefined;
  if (Number(bytes) < 1 || Number(bytes) > MAX_BACKGROUND_STORED_BYTES) return undefined;
  const variants: Record<string, BackgroundVariant> = {};
  if (record.variants && typeof record.variants === 'object' && !Array.isArray(record.variants)) {
    for (const [key, variant] of Object.entries(record.variants as Record<string, unknown>)) {
      const blur = Number(key);
      if (!Number.isInteger(blur) || blur < 1 || blur > MAX_BACKGROUND_BLUR) continue;
      const clean = sanitizeVariant(variant);
      if (clean) variants[String(blur)] = clean;
    }
  }
  return {
    id: record.id,
    name: typeof record.name === 'string' && record.name.length <= 260 ? record.name : 'background.webp',
    width: Number(width),
    height: Number(height),
    bytes: Number(bytes),
    importedAt: typeof record.importedAt === 'string' && record.importedAt.length <= 40 ? record.importedAt : new Date(0).toISOString(),
    stats,
    variants,
  };
}

/** Parses manifest text, dropping records that do not satisfy the caps; undefined when the file is not a manifest. */
export function parseBackgroundManifest(text: string): BackgroundManifest | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const images = (value as { images?: unknown }).images;
  if (!Array.isArray(images)) return undefined;
  const seen = new Set<string>();
  const kept: BackgroundRecord[] = [];
  for (const item of images) {
    const record = sanitizeRecord(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    kept.push(record);
    if (kept.length >= MAX_BACKGROUND_IMAGES) break;
  }
  return { version: 1, images: kept };
}

/** Reads the manifest; a missing one is empty, a corrupt one is logged and rebuilt empty. Never throws. */
export async function readBackgroundManifest(folder: string, log: Pick<Console, 'warn'> = console): Promise<BackgroundManifest> {
  const folders = backgroundFolders(folder);
  let text: string;
  try { text = await fs.readFile(folders.manifest, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Background manifest could not be read', error);
    return emptyManifest();
  }
  const manifest = parseBackgroundManifest(text);
  if (manifest) return manifest;
  log.warn('Background manifest was corrupt; rebuilding an empty one');
  try { await writeBackgroundManifest(folder, emptyManifest()); } catch { /* a later write retries */ }
  return emptyManifest();
}

/** Atomic manifest write: temp file in the same folder, then rename. */
export async function writeBackgroundManifest(folder: string, manifest: BackgroundManifest): Promise<void> {
  const folders = backgroundFolders(folder);
  await fs.mkdir(folders.root, { recursive: true });
  const temp = join(folders.root, `manifest.${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify({ version: 1, images: manifest.images }, null, 2)}\n`, 'utf8');
  await fs.rename(temp, folders.manifest);
}

// ---------------------------------------------------------------- source files

export interface BackgroundSourceFile { name: string; mime: string; bytes: Uint8Array }

/** The bridge surface the desktop exposes for background images (renderer/src/appearance/backgroundPipeline.ts). */
export interface BackgroundBridge {
  pickBackgroundImage(): Promise<BackgroundSourceFile | null>;
  readBackgroundSource(path: string): Promise<BackgroundSourceFile>;
  storeBackgroundImage(input: { name: string; bytes: Uint8Array; width: number; height: number; stats: ImageStats }): Promise<BackgroundRecord>;
  storeBackgroundVariant(input: { id: string; blur: number; bytes: Uint8Array; width: number; height: number; stats: ImageStats }): Promise<BackgroundRecord>;
  listBackgroundImages(): Promise<BackgroundRecord[]>;
  removeBackgroundImage(id: string): Promise<void>;
  pruneBackgroundImages(keepIds: readonly string[]): Promise<void>;
}

/** An absolute, control-free path of at most 4096 characters (paths reach us from the picker or a drop). */
export function validBackgroundSourcePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

/** QA points the native picker at a fixture; ignored in packaged builds. */
export function qaBackgroundPickOverride(envValue: string | undefined, isPackaged: boolean): string | undefined {
  if (isPackaged || !envValue || envValue.length > 4096 || !isAbsolute(envValue)) return undefined;
  return envValue;
}

/** Reads one source file: regular file, cap by stat first, then magic bytes. Throws BackgroundImageError. */
export async function readBackgroundSource(path: unknown): Promise<BackgroundSourceFile> {
  if (!validBackgroundSourcePath(path)) throw new BackgroundImageError('background_image_unreadable', 'invalid path');
  let info: { isFile(): boolean; size: number };
  try { info = await fs.stat(path); }
  catch (error) { throw new BackgroundImageError('background_image_unreadable', (error as Error).message); }
  if (!info.isFile()) throw new BackgroundImageError('background_image_unreadable', 'not a file');
  if (info.size > MAX_BACKGROUND_SOURCE_BYTES) throw new BackgroundImageError('background_image_too_large', `${info.size} bytes`);
  let buffer: Buffer;
  try { buffer = await fs.readFile(path); }
  catch (error) { throw new BackgroundImageError('background_image_unreadable', (error as Error).message); }
  const sniffed = sniffImageBytes(buffer);
  if (!sniffed.ok) {
    if (sniffed.reason === 'gif') throw new BackgroundImageError('background_image_unsupported', 'animated images are not supported');
    throw new BackgroundImageError('background_image_unsupported', sniffed.reason);
  }
  return { name: basename(path), mime: sniffed.mime, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
}

// ---------------------------------------------------------------- store

const saneEdge = (value: unknown): number | undefined => {
  const edge = Number(value);
  return Number.isInteger(edge) && edge >= 1 && edge <= MAX_BACKGROUND_EDGE ? edge : undefined;
};

const sanitizeName = (value: unknown): string => {
  if (typeof value !== 'string') return 'background.webp';
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 260);
  return name || 'background.webp';
};

const asBytes = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
};

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, bytes);
  try { await fs.rename(temp, path); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

async function readdirOrEmpty(path: string): Promise<string[]> {
  try { return await fs.readdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

export interface BackgroundImageInput { name?: unknown; bytes?: unknown; width?: unknown; height?: unknown; stats?: unknown }

/** Stores a prepared original (WebP, ≤ 16 MiB, ≤ 3840 px). Re-importing identical bytes returns the existing record. */
export async function storeBackgroundImage(folder: string, input: BackgroundImageInput): Promise<BackgroundRecord> {
  const folders = backgroundFolders(folder);
  const bytes = asBytes(input.bytes);
  if (!bytes || bytes.length === 0) throw new BackgroundImageError('background_image_unreadable', 'no bytes');
  if (bytes.length > MAX_BACKGROUND_STORED_BYTES) throw new BackgroundImageError('background_image_too_large', `${bytes.length} bytes`);
  const sniffed = sniffImageBytes(bytes);
  if (!sniffed.ok || sniffed.format !== 'webp') throw new BackgroundImageError('background_image_unsupported', 'a prepared background must be WebP');
  const measured = webpDimensions(bytes);
  const width = saneEdge(measured?.width ?? input.width);
  const height = saneEdge(measured?.height ?? input.height);
  if (!width || !height) throw new BackgroundImageError('background_image_unreadable', 'invalid dimensions');
  const id = createHash('sha256').update(bytes).digest('hex');
  const manifest = await readBackgroundManifest(folder);
  const existing = manifest.images.find(record => record.id === id);
  if (existing) return existing;
  if (manifest.images.length >= MAX_BACKGROUND_IMAGES) throw new BackgroundImageError('background_image_limit', `${manifest.images.length} images`);
  const record: BackgroundRecord = {
    id,
    name: sanitizeName(input.name),
    width,
    height,
    bytes: bytes.length,
    importedAt: new Date().toISOString(),
    stats: sanitizeStats(input.stats) ?? { dark: [], bright: [] },
    variants: {},
  };
  await fs.mkdir(folders.images, { recursive: true });
  await writeAtomic(join(folders.images, backgroundImageFileName(id)), bytes);
  manifest.images.push(record);
  await writeBackgroundManifest(folder, manifest);
  return record;
}

export interface BackgroundVariantInput { id?: unknown; blur?: unknown; bytes?: unknown; width?: unknown; height?: unknown; stats?: unknown }

/** Stores a baked blur variant under `Cache/` and records its statistics on the original's record. */
export async function storeBackgroundVariant(folder: string, input: BackgroundVariantInput): Promise<BackgroundRecord> {
  const folders = backgroundFolders(folder);
  if (!validBackgroundId(input.id)) throw new BackgroundImageError('background_image_unreadable', 'invalid id');
  const blur = Number(input.blur);
  if (!Number.isInteger(blur) || blur < 1 || blur > MAX_BACKGROUND_BLUR) throw new BackgroundImageError('background_image_unreadable', 'invalid blur');
  const bytes = asBytes(input.bytes);
  if (!bytes || bytes.length === 0) throw new BackgroundImageError('background_image_unreadable', 'no bytes');
  if (bytes.length > MAX_BACKGROUND_STORED_BYTES) throw new BackgroundImageError('background_image_too_large', `${bytes.length} bytes`);
  const sniffed = sniffImageBytes(bytes);
  if (!sniffed.ok || sniffed.format !== 'webp') throw new BackgroundImageError('background_image_unsupported', 'a baked variant must be WebP');
  const measured = webpDimensions(bytes);
  const width = saneEdge(measured?.width ?? input.width);
  const height = saneEdge(measured?.height ?? input.height);
  if (!width || !height) throw new BackgroundImageError('background_image_unreadable', 'invalid dimensions');
  const manifest = await readBackgroundManifest(folder);
  const record = manifest.images.find(item => item.id === input.id);
  if (!record) throw new BackgroundImageError('background_image_unreadable', 'unknown background');
  await fs.mkdir(folders.cache, { recursive: true });
  await writeAtomic(join(folders.cache, backgroundVariantFileName(record.id, blur)), bytes);
  record.variants[String(blur)] = { width, height, stats: sanitizeStats(input.stats) ?? { dark: [], bright: [] } };
  await writeBackgroundManifest(folder, manifest);
  return record;
}

export async function listBackgroundImages(folder: string): Promise<BackgroundRecord[]> {
  return (await readBackgroundManifest(folder)).images;
}

/** Removes one original and every baked variant of it. */
export async function removeBackgroundImage(folder: string, id: unknown): Promise<void> {
  const folders = backgroundFolders(folder);
  if (typeof id !== 'string') return;
  const manifest = await readBackgroundManifest(folder);
  const remaining = manifest.images.filter(record => record.id !== id);
  if (validBackgroundId(id)) {
    await fs.rm(join(folders.images, backgroundImageFileName(id)), { force: true });
    for (const name of await readdirOrEmpty(folders.cache)) {
      if (name.startsWith(`${id}-b`) && name.endsWith('.webp')) await fs.rm(join(folders.cache, name), { force: true });
    }
  }
  if (remaining.length !== manifest.images.length) await writeBackgroundManifest(folder, { version: 1, images: remaining });
}

/** Keeps exactly the given ids: records and files of everything else are deleted. */
export async function pruneBackgroundImages(folder: string, keepIds: readonly unknown[]): Promise<void> {
  const folders = backgroundFolders(folder);
  const keep = new Set(keepIds.filter(validBackgroundId));
  const manifest = await readBackgroundManifest(folder);
  const kept = manifest.images.filter(record => keep.has(record.id));
  for (const name of await readdirOrEmpty(folders.images)) {
    const match = /^([a-f0-9]{64})\.webp$/.exec(name);
    if (match && !keep.has(match[1])) await fs.rm(join(folders.images, name), { force: true });
  }
  for (const name of await readdirOrEmpty(folders.cache)) {
    const match = /^([a-f0-9]{64})-b\d+\.webp$/.exec(name);
    if (match && !keep.has(match[1])) await fs.rm(join(folders.cache, name), { force: true });
  }
  if (kept.length !== manifest.images.length) await writeBackgroundManifest(folder, { version: 1, images: kept });
}

// ---------------------------------------------------------------- protocol URLs

export interface BackgroundRequest { id: string; blur?: number }

/** `threadterm-bg://image/<id>` or `threadterm-bg://image/<id>/b<blur>`; anything else is not a request at all. */
export function parseBackgroundUrl(raw: unknown): BackgroundRequest | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  // Reject dot segments, encoded separators and Windows separators before URL normalisation can hide them.
  if (raw.includes('..') || raw.includes('%') || raw.includes('\\')) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== `${BACKGROUND_IMAGE_SCHEME}:`) return undefined;
  if (url.hostname !== 'image' || url.username || url.password || url.search || url.hash) return undefined;
  const path = url.pathname;
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 1 && segments.length !== 2) return undefined;
  const id = segments[0];
  if (!validBackgroundId(id)) return undefined;
  if (segments.length === 1) return { id };
  const match = /^b(0|[1-9][0-9]*)$/.exec(segments[1]);
  if (!match) return undefined;
  const blur = Number(match[1]);
  if (!Number.isInteger(blur) || blur < 1 || blur > MAX_BACKGROUND_BLUR) return undefined;
  return { id, blur };
}

/** Where a parsed request is served from: the original folder, or `Cache/` for a baked variant. */
export function backgroundRequestPath(folder: string, request: BackgroundRequest): string {
  const folders = backgroundFolders(folder);
  return request.blur === undefined
    ? join(folders.images, backgroundImageFileName(request.id))
    : join(folders.cache, backgroundVariantFileName(request.id, request.blur));
}

/** The renderer-facing URL of an image (or of one baked blur variant of it). */
export function backgroundImageUrl(id: string, blur?: number): string {
  const suffix = blur === undefined ? '' : `/b${blur}`;
  return `${BACKGROUND_IMAGE_SCHEME}://image/${id}${suffix}`;
}
