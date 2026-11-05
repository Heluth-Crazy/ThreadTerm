import type { FileDocument, GitDiff } from '@threadterm/protocol';
import { isLargeFileError } from './largeFileWindow';

/** A deleted tracked file has a diff even though it has no editable disk document. */
export async function readDiffDocument(path: string, read: () => Promise<FileDocument>, diff: () => Promise<GitDiff>): Promise<FileDocument & { diffOnly?: true }> {
  try {
    return await read();
  } catch (readError) {
    // Large on-disk files go straight to the bounded viewer, even from a diff tab.
    // Probing Git here would read content the viewer will never use.
    if (isLargeFileError(readError)) throw readError;
    let value: GitDiff;
    try { value = await diff(); } catch { throw readError; }
    if (!value.deleted && !value.binary) throw readError;
    return { path, content: '', fingerprint: value.fingerprint, readonly: true, size: 0, modifiedAt: '', diffOnly: true };
  }
}
