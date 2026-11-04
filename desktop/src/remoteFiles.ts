import type { RuntimeClient } from './runtime-client.js';
import { MAX_PAGE_SHOT_BYTES, validPageShotId } from './pageCommentsCore.js';

function hostRootKey(path: string): string {
  const windows = /^(?:[a-z]:[/\\]|\\\\|\/\/)/i.test(path);
  const normalized = path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '');
  return windows ? normalized.toLowerCase() : normalized;
}

/** Pick a session in the review's exact host root, including registered worktrees. */
export function reviewShotSession(snapshot: { projects: { id: string; path: string }[]; sessions: { id: string; projectId?: string; worktreePath?: string }[] }, projectId: unknown, root: unknown): string | undefined {
  if (typeof projectId !== 'string' || typeof root !== 'string') return;
  const project = snapshot.projects.find(project => project.id === projectId);
  return snapshot.sessions.find(session => session.projectId === projectId
    && hostRootKey(session.worktreePath ?? project?.path ?? '') === hostRootKey(root))?.id;
}

/** Shared by remote screenshot readers; no host filesystem path is opened on the client. */
export async function readHostPageShot(runtime: Pick<RuntimeClient, 'request'>, id: unknown): Promise<string | undefined> {
  if (!validPageShotId(id)) throw new Error('Invalid page shot id');
  const chunks: Buffer[] = [];
  let offset = 0, size: number | undefined, mime = '';
  for (;;) {
    const result = await runtime.request('attachment.read', { assetId: id, offset, limit: 1024 * 1024 });
    if (size === undefined) { size = result.size; mime = result.name.toLowerCase().endsWith('.png') ? 'image/png' : result.name.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : ''; }
    const bytes = Buffer.from(result.chunk, 'base64');
    if (!mime || !Number.isSafeInteger(size) || size < 0 || size > MAX_PAGE_SHOT_BYTES || result.size !== size
      || result.offset !== offset || bytes.length > 1024 * 1024 || offset + bytes.length > size
      || (!bytes.length && offset < size) || result.eof !== (offset + bytes.length === size)) throw new Error('Invalid host screenshot');
    chunks.push(bytes); offset += bytes.length;
    if (result.eof) return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
  }
}
