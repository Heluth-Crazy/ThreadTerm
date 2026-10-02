// Clipboard images stay separate from text and are sent as native image inputs.
export const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CHAT_IMAGES = 4;
export function isChatImage(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
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
