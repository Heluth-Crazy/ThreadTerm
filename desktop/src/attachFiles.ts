// Files picked through the desktop's native open dialog (task 10-11-chat-parity F3).
//
// The dialog chooses the paths, so the renderer never supplies one. Every
// returned path is validated again here: it must be an absolute, control-free
// string, and only a regular file is returned. Images are read into a data URL
// only while they still fit the composer's shared count and byte budget; every
// other file (and every image beyond that budget) stays a path for a `file`
// context chip.
//
// Reads are asynchronous so a slow or large file never blocks the main process,
// and the encoded budget is checked from `stat().size` before reading, so a pick
// never reads more raw bytes than the composer could ever accept.
import { promises as fs } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeClient } from './runtime-client.js';
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES } from '@threadterm/protocol';

export const MAX_ATTACH_FILES = 20;
/** Encoded data-URL bytes the picker may inline per pick; never more than the composer's whole budget. */
export const MAX_ATTACH_INLINE_BYTES = MAX_CHAT_IMAGE_BYTES;
export type AttachedFile = { path: string; name: string; dataUrl?: string };

const imageMimes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Base64 length of `bytes` raw bytes (RFC 4648, with padding). */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(Math.max(0, bytes) / 3);
}

/** Length of the data URL the composer would store for `bytes` of `mime`; keeps the desktop budget in sync with the renderer. */
export function attachmentDataUrlLength(mime: string, bytes: number): number {
  return `data:${mime};base64,`.length + base64Length(bytes);
}

export function validAttachPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && isAbsolute(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The QA attach-file override applies only in an unpackaged build and only when the env var has a value. */
export function qaAttachPathsOverride(envValue: string | undefined, isPackaged: boolean): string[] | undefined {
  if (isPackaged || !envValue) return undefined;
  return envValue.split(';');
}

export function attachmentImageMime(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? imageMimes[extension] : undefined;
}

type ReadFile = (path: string) => Promise<Buffer>;
type StatFile = (path: string) => Promise<{ isFile(): boolean; size: number }>;

const defaultReadFile: ReadFile = path => fs.readFile(path);
const defaultStat: StatFile = path => fs.stat(path);

/** Validates the chosen paths and reads readable images; unreadable or invalid entries are skipped. */
export async function readAttachFiles(
  paths: readonly unknown[],
  readFile: ReadFile = defaultReadFile,
  stat: StatFile = defaultStat,
): Promise<AttachedFile[]> {
  const files: AttachedFile[] = [];
  let inlineCount = 0;
  let inlineBytes = 0;
  for (const candidate of paths) {
    if (files.length >= MAX_ATTACH_FILES) break;
    if (!validAttachPath(candidate)) continue;
    let info: { isFile(): boolean; size: number };
    try { info = await stat(candidate); } catch { continue; }
    if (!info.isFile()) continue;
    const name = basename(candidate);
    const mime = attachmentImageMime(name);
    if (mime && inlineCount < MAX_CHAT_IMAGES
        && inlineBytes + attachmentDataUrlLength(mime, info.size) <= MAX_ATTACH_INLINE_BYTES) {
      try {
        const dataUrl = `data:${mime};base64,${(await readFile(candidate)).toString('base64')}`;
        // Re-check the real length in case the file changed between stat and read.
        if (inlineBytes + dataUrl.length <= MAX_ATTACH_INLINE_BYTES) {
          files.push({ path: candidate, name, dataUrl });
          inlineCount += 1;
          inlineBytes += dataUrl.length;
          continue;
        }
      } catch { /* Fall through to a path-only attachment. */ }
    }
    files.push({ path: candidate, name });
  }
  return files;
}

/** Remote path chips are uploaded from the client; inline image payloads never enter this path. */
export async function uploadAttachFile(runtime: Pick<RuntimeClient, 'request'>, sessionId: string, path: string, uploadId = randomUUID()): Promise<{ assetId: string; hostPath: string }> {
  if (!validAttachPath(path) || !sessionId) throw new Error('Invalid attachment');
  const handle = await fs.open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error('Attachment must be a file no larger than 256 MiB');
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    do {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead && offset < before.size) throw new Error('Attachment changed while uploading');
      const final = offset + bytesRead === before.size;
      const result = await runtime.request('attachment.upload', { uploadId, sessionId, name: basename(path), size: before.size, offset, chunk: buffer.subarray(0, bytesRead).toString('base64'), final });
      offset += bytesRead;
      if (result.offset !== offset) throw new Error('Unexpected attachment upload offset');
      const current = await handle.stat();
      if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) throw new Error('Attachment changed while uploading');
      if (final) {
        if (!result.assetId || !result.hostPath) throw new Error('Attachment upload did not finish');
        return { assetId: result.assetId, hostPath: result.hostPath };
      }
    } while (offset < before.size);
    throw new Error('Attachment upload did not finish');
  } finally { await handle.close(); }
}
