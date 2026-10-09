import { markPageTarget } from "./bridge";
import { pageTargetRef, type PageComment } from "./reviewComments";

const previews = new Map<string, { documentId?: string; navigation?: number; frameName: string; isVisible: () => boolean }[]>();

/** Registers one preview identity. URLs are not identities: two sessions can render the same URL. */
export function registerPagePreview(previewId: string, documentId: string | undefined, navigation: number | undefined, frameName: string, isVisible: () => boolean = () => true): () => void {
  if (!previewId || !frameName) return () => {};
  const names = previews.get(previewId) ?? [];
  previews.set(previewId, [...names.filter(item => item.frameName !== frameName), { documentId, navigation, frameName, isVisible }]);
  return () => { const next = (previews.get(previewId) ?? []).filter(item => item.frameName !== frameName); if (next.length) previews.set(previewId, next); else previews.delete(previewId); };
}

/** Briefly brings a pending page comment into view when its preview remains open. */
export async function flashPageComment(comment: PageComment): Promise<boolean> {
  const frameName = comment.provenance?.previewId ? previews.get(comment.provenance.previewId)?.slice().reverse().find(item => item.isVisible() && item.documentId === comment.provenance?.documentId && item.navigation === comment.provenance?.navigation)?.frameName : undefined;
  return frameName ? markPageTarget({ frameName, target: pageTargetRef(comment.target), flash: true }) : false;
}
