import { request } from '../bridge';
import type { ThemeTokens } from '../themes';
import { referencedImageIds } from './backgrounds';
import { listBackgroundImages, pruneBackgroundImages, removeBackgroundImage } from './backgroundPipeline';

let pending: Promise<unknown> = Promise.resolve();
/** Web Locks share one user-action queue across app windows, including import's store → settings gap. */
export function withBackgroundMutation<T>(action: () => Promise<T>): Promise<T> {
 const run = async (): Promise<T> => typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request('threadterm-background-mutation', action) : await action();
 const next = pending.then(run, run);
 pending = next.catch(() => {});
 return next;
}

/** Prune only pictures this action removed. Unrelated, newly imported library pictures must survive. */
export async function pruneRemovedBackgrounds(before: Record<string, ThemeTokens>, after: Record<string, ThemeTokens>) {
 const wanted = referencedImageIds(after);
 const removed = new Set([...referencedImageIds(before)].filter(id => !wanted.has(id)));
 if (!removed.size) return;
 const current = (await request('runtime.snapshot', {})).settings.customThemes as Record<string, ThemeTokens> | undefined;
 const keep = referencedImageIds(current);
 for (const record of await listBackgroundImages()) if (!removed.has(record.id)) keep.add(record.id);
 await pruneBackgroundImages([...keep]);
}

/** Roll back only newly stored, still unreferenced pictures after a rejected settings patch. */
export async function discardUnreferencedImports(ids: readonly string[]) {
 const current = (await request('runtime.snapshot', {})).settings.customThemes as Record<string, ThemeTokens> | undefined;
 const keep = referencedImageIds(current);
 for (const id of ids) if (!keep.has(id)) await removeBackgroundImage(id);
}
