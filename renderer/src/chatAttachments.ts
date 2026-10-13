// File attachments picked through the native dialog (task 10-11-chat-parity F3).
//
// Images become composer image attachments (the existing data-URL path); every
// other file becomes a `file` context chip the agent can read by path. An image
// the composer cannot accept (count or data-URL byte budget, including images
// already in the composer) also falls back to a `file` chip, so a picked file is
// never silently dropped.
import type { FileContextItem } from './chatContext';
import { selectChatImageIndices } from './chatImages';

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

export type AttachedFilesPlan = {
  /** Data URLs the composer accepted as image attachments. */
  images: string[];
  /** Context chips: every non-image file, plus any image the composer could not accept. */
  files: FileContextItem[];
  /** How many picked images were inlined by the picker but landed as file chips. */
  imagesAsFiles: number;
};

/**
 * Splits a picked batch into accepted image payloads and file context chips,
 * preserving order. `existing` is the composer's current image list, so the
 * plan uses the same count and byte budget the composer itself enforces.
 */
export function partitionAttachedFiles(
  files: readonly AttachedFile[],
  existing: readonly string[],
  supported: boolean,
  id: (path: string) => string,
): AttachedFilesPlan {
  const candidates: { file: AttachedFile; dataUrl: string }[] = [];
  const contexts: FileContextItem[] = [];
  for (const file of files) {
    if (file.dataUrl && isAttachmentImage(file.name)) candidates.push({ file, dataUrl: file.dataUrl });
    else contexts.push(fileAttachmentItem(file.path, id(file.path)));
  }
  const accepted = new Set(selectChatImageIndices(existing, candidates.map(candidate => candidate.dataUrl), supported));
  const images: string[] = [];
  let imagesAsFiles = 0;
  candidates.forEach((candidate, index) => {
    if (accepted.has(index)) images.push(candidate.dataUrl);
    else { contexts.push(fileAttachmentItem(candidate.file.path, id(candidate.file.path))); imagesAsFiles += 1; }
  });
  return { images, files: contexts, imagesAsFiles };
}
