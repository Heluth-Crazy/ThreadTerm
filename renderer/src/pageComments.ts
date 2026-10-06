import { markPageTarget } from "./bridge";
import { pageTargetRef, type PageComment } from "./reviewComments";

const previews = new Map<string, { frameName: string; isVisible: () => boolean }[]>();

/** Registers the currently mounted preview for a URL. The newest preview wins. */
export function registerPagePreview(url: string, frameName: string, isVisible: () => boolean = () => true): () => void {
  if (!url || !frameName) return () => {};
  const names = previews.get(url) ?? [];
  previews.set(url, [...names.filter(item => item.frameName !== frameName), { frameName, isVisible }]);
  return () => { const next = (previews.get(url) ?? []).filter(item => item.frameName !== frameName); if (next.length) previews.set(url, next); else previews.delete(url); };
}

/** Briefly brings a pending page comment into view when its preview remains open. */
export async function flashPageComment(comment: PageComment): Promise<boolean> {
  const frameName = previews.get(comment.url)?.slice().reverse().find(item => item.isVisible())?.frameName;
  return frameName ? markPageTarget({ frameName, target: pageTargetRef(comment.target), flash: true }) : false;
}
