// File attachments picked through the native dialog (task 10-11-chat-parity F3).
//
// Images become composer image attachments (the existing data-URL path); every
// other file becomes a `file` context chip the agent can read by path.
import type { FileContextItem } from './chatContext';

export type AttachedFile = { path: string; name: string; dataUrl?: string };

const imageExtensions: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function attachmentFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function attachmentImageMime(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? imageExtensions[extension] : undefined;
}

export function isAttachmentImage(name: string): boolean {
  return attachmentImageMime(name) !== undefined;
}

export function fileAttachmentItem(path: string, id: string): FileContextItem {
  return { kind: 'file', id, path };
}

/** Splits a picked batch into image payloads and file context chips, preserving order. */
export function partitionAttachedFiles(files: readonly AttachedFile[], id: (path: string) => string): { images: string[]; files: FileContextItem[] } {
  const images: string[] = [];
  const contexts: FileContextItem[] = [];
  for (const file of files) {
    if (file.dataUrl && isAttachmentImage(file.name)) images.push(file.dataUrl);
    else contexts.push(fileAttachmentItem(file.path, id(file.path)));
  }
  return { images, files: contexts };
}
