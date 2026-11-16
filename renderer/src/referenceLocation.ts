import type { FileReference } from '@threadterm/protocol';
import { parseFileReference } from './fileReferences';

/** Reference metadata is not authority: keep the originating session for main's resolver.
 * Unlike Markdown href parsing this never URL-decodes literal filenames. */
export function referenceLocationTarget(sessionId: string | undefined, reference: FileReference): { sessionId: string; path: string } | undefined {
  if (!sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(sessionId)) return;
  if (!reference.path || reference.path.length > 16384 || /\p{Cc}/u.test(reference.path)) return;
  const parsed = parseFileReference(reference.path);
  // Structured native references may be extensionless. Keep them literal, but never accept a URI.
  const path = parsed?.path ?? reference.path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) || path.includes('://')) return;
  return { sessionId, path };
}

/** The keyboard terminal menu accepts a complete explicit reference, never a multiline selection. */
export function selectedTerminalFileReference(selection: string): FileReference | undefined {
  if (/[\r\n]/.test(selection)) return;
  return parseFileReference(selection);
}
