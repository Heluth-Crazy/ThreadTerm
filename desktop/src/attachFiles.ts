// Files picked through the desktop's native open dialog (task 10-11-chat-parity F3).
//
// The dialog chooses the paths, so the renderer never supplies one. Every
// returned path is validated again here: it must be an absolute, control-free
// string, and only a regular file is returned. Images within the composer's
// 4 MiB data-URL budget are read into a data URL; everything else stays a path
// for a `file` context chip.
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

export const MAX_ATTACH_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACH_FILES = 20;
export type AttachedFile = { path: string; name: string; dataUrl?: string };

const imageMimes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function validAttachPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && isAbsolute(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function attachmentImageMime(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? imageMimes[extension] : undefined;
}

type ReadFile = (path: string) => Buffer;
type StatFile = (path: string) => { isFile(): boolean; size: number };

/** Validates the chosen paths and reads readable images; unreadable or invalid entries are skipped. */
export function readAttachFiles(paths: readonly unknown[], readFile: ReadFile = readFileSync, stat: StatFile = statSync): AttachedFile[] {
  const files: AttachedFile[] = [];
  for (const candidate of paths) {
    if (files.length >= MAX_ATTACH_FILES) break;
    if (!validAttachPath(candidate)) continue;
    let info: { isFile(): boolean; size: number };
    try { info = stat(candidate); } catch { continue; }
    if (!info.isFile()) continue;
    const name = basename(candidate);
    const mime = attachmentImageMime(name);
    if (mime && info.size <= MAX_ATTACH_IMAGE_BYTES) {
      try {
        files.push({ path: candidate, name, dataUrl: `data:${mime};base64,${readFile(candidate).toString('base64')}` });
        continue;
      } catch { /* Fall through to a path-only attachment. */ }
    }
    files.push({ path: candidate, name });
  }
  return files;
}
