// Clipboard images stay separate from text and are sent as native image inputs.
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES } from '@threadterm/protocol';
export { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES };
export function isChatImage(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
/** A transcript page replaced an oversized inline image with this reference;
 * the bytes stay in the local runtime and are read on demand. */
export type ChatImageRef = { itemId: string; part: number; index: number; bytes?: number; mime?: string };
export function isChatImageRef(value: unknown): value is ChatImageRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.itemId === 'string' && ref.itemId.length > 0
    && Number.isSafeInteger(ref.part) && Number(ref.part) >= 0
    && Number.isSafeInteger(ref.index) && Number(ref.index) >= 0;
}
export function validateChatImages(images: unknown): string[] {
  if (!Array.isArray(images) || images.length > MAX_CHAT_IMAGES || !images.every(isChatImage)
      || images.reduce((size, image) => size + image.length, 0) > MAX_CHAT_IMAGE_BYTES) {
    throw new Error('Paste up to four PNG, JPEG, GIF or WebP images, totaling at most 4 MiB. / 请粘贴最多四张 PNG、JPEG、GIF 或 WebP 图片，总大小不超过 4 MiB。');
  }
  return images;
}
export function readClipboardImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > MAX_CHAT_IMAGE_BYTES) {
    return Promise.reject(new Error('This image format or size is not supported. / 不支持此图片格式或大小。'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => isChatImage(reader.result) ? resolve(reader.result) : reject(new Error('Could not read the image. / 无法读取图片。'));
    reader.onerror = () => reject(new Error('Could not read the image. / 无法读取图片。'));
    reader.readAsDataURL(file);
  });
}
/**
 * Indices of `incoming` that fit the composer's existing count and data-URL
 * byte budget, skipping entries that do not. Index-based so callers can map a
 * rejected image back to its source path even when data URLs repeat.
 */
export function selectChatImageIndices(existing:readonly string[], incoming:readonly string[], supported:boolean):number[] {
  if(!supported) return [];
  const accepted:number[]=[];
  let bytes=existing.reduce((size,image)=>size+image.length,0);
  for(let index=0;index<incoming.length;index+=1) {
    const image=incoming[index]!;
    if(existing.length+accepted.length>=MAX_CHAT_IMAGES) break;
    if(!isChatImage(image)||bytes+image.length>MAX_CHAT_IMAGE_BYTES) continue;
    accepted.push(index); bytes+=image.length;
  }
  return accepted;
}
/** Takes as many supported screenshots as fit the composer's existing count and data-URL byte budget. */
export function selectChatImageAttachments(existing:readonly string[], incoming:readonly string[], supported:boolean):string[] {
  return selectChatImageIndices(existing,incoming,supported).map(index=>incoming[index]!);
}
