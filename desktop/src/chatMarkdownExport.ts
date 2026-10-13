import type { IpcMainInvokeEvent, SaveDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
type AssetFiles = { createDirectory: (path: string) => Promise<void>; writeImage: (path: string, bytes: Buffer) => Promise<void>; unlink: (path: string) => Promise<void>; removeDirectory: (path: string) => Promise<void> };
type Dependencies = { assertTrusted: (event: IpcMainInvokeEvent) => void; choosePath: (options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>; write: (path: string, content: string, canPublish: () => boolean) => Promise<void | boolean>; alive: () => boolean; files?: AssetFiles };
const MAX_BYTES = 64 * 1024 * 1024;
/** Exclusive creation means cleanup owns exactly this file, never a pre-existing file. */
async function writeExclusive(path: string, content: string | Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.close(); }
  catch (error) {
    await handle.close().catch(() => {});
    try { await unlink(path); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Export write failed; temporary file cleanup incomplete', { cause: error }); }
    throw error;
  }
}
export const nativeMarkdownExportFiles: AssetFiles = {
  createDirectory: async path => { await mkdir(path, { mode: 0o700 }); }, writeImage: writeExclusive, unlink, removeDirectory: rmdir,
};
/** Publish a complete sibling file; failure before rename preserves an existing export. */
export async function writeChatMarkdownAtomic(path: string, content: string, canPublish: () => boolean): Promise<boolean> {
  const temporary = join(dirname(path), `.threadterm-chat-${randomUUID()}.tmp`);
  await writeExclusive(temporary, content);
  let published = false, failure: unknown;
  try {
    if (!canPublish()) return false;
    await rename(temporary, path); published = true; return true;
  } catch (error) { failure = error; throw error; }
  finally { if (!published) try { await unlink(temporary); } catch (cleanup) { throw new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Markdown export failed; temporary file cleanup incomplete', { cause: failure }); } }
}
function imageBytes(dataUrl: string, available: number): { extension: string; bytes: Buffer } {
  if (dataUrl.length > Math.ceil(available / 3) * 4 + 40) throw new Error('Invalid Markdown export size');
  const match = /^data:image\/(png|jpeg|gif|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(dataUrl);
  if (!match?.[2] || match[2].length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('Invalid Markdown export image');
  const decodedLength = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  if (decodedLength > available) throw new Error('Invalid Markdown export size');
  const bytes = Buffer.from(match[2], 'base64');
  const extension = match[1]!;
  const magic = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : extension === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
    : extension === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!magic || bytes.toString('base64') !== match[2]) throw new Error('Invalid Markdown export image');
  return { extension, bytes };
}
/** The renderer supplies content, never a destination. Only the native dialog chooses the file. */
export async function saveChatMarkdown(event: IpcMainInvokeEvent, payload: unknown, deps: Dependencies): Promise<string | null> {
  deps.assertTrusted(event);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Markdown export');
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some(key => !['title', 'markdown', 'locale', 'images', 'assetToken'].includes(key)) || typeof value.title !== 'string' || value.title.length > 4096 || typeof value.markdown !== 'string' || (value.locale !== undefined && value.locale !== 'en' && value.locale !== 'zh-CN') || (value.assetToken !== undefined && (typeof value.assetToken !== 'string' || !/^__THREADTERM_CHAT_ASSETS_[a-f0-9-]{36}__$/.test(value.assetToken)))) throw new Error('Invalid Markdown export');
  let bytes = Buffer.byteLength(value.markdown, 'utf8');
  if (bytes > MAX_BYTES || (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 1000))) throw new Error('Invalid Markdown export');
  const images: { name: string; bytes: Buffer }[] = [];
  const rawImages = (value.images ?? []) as unknown[];
  for (let index = 0; index < rawImages.length; index++) {
    const image = rawImages[index];
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).length !== 2 || Object.keys(image).some(key => key !== 'name' && key !== 'dataUrl') || typeof (image as Record<string, unknown>).dataUrl !== 'string' || !value.assetToken) throw new Error('Invalid Markdown export image');
    const decoded = imageBytes((image as { dataUrl: string }).dataUrl, MAX_BYTES - bytes);
    const name = `image-${index + 1}.${decoded.extension}`;
    if ((image as { name: unknown }).name !== name) throw new Error('Invalid Markdown export image');
    bytes += decoded.bytes.length;
    if (bytes > MAX_BYTES) throw new Error('Invalid Markdown export size');
    images.push({ name, bytes: decoded.bytes });
  }
  const names = new Set(images.map(image => image.name)), referenced = new Set<string>();
  const referencePattern = value.assetToken ? new RegExp(`<${value.assetToken}/(image-[0-9]+\\.(?:png|jpeg|gif|webp))>`, 'g') : /$^/g;
  const remaining = value.markdown.replace(referencePattern, (_match, name: string) => { if (!names.has(name)) throw new Error('Invalid Markdown export reference'); referenced.add(name); return ''; });
  if (referenced.size !== images.length) throw new Error('Invalid Markdown export reference');
  if (value.assetToken && remaining.includes(value.assetToken as string)) throw new Error('Invalid Markdown export reference');
  const filename = value.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || 'conversation';
  const saved = await deps.choosePath({ title: value.locale === 'zh-CN' ? '导出对话为 Markdown' : 'Export conversation as Markdown', defaultPath: `${filename}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
  const canPublish = () => { if (!deps.alive()) return false; deps.assertTrusted(event); return true; };
  if (saved.canceled || !saved.filePath || !canPublish()) return null;
  const folderName = `threadterm-chat-images-${randomUUID()}`, folder = join(dirname(saved.filePath), folderName);
  const owned: string[] = []; let directoryCreated = false, published = false, failure: unknown;
  try {
    let markdown = value.markdown;
    if (images.length) {
      if (!deps.files) throw new Error('Image export is unavailable');
      await deps.files.createDirectory(folder); directoryCreated = true;
      for (const image of images) {
        if (!canPublish()) return null;
        const path = join(folder, image.name); await deps.files.writeImage(path, image.bytes); owned.push(path);
        if (!canPublish()) return null;
      }
      markdown = markdown.replace(referencePattern, (_match, name: string) => `<${folderName}/${name}>`);
    }
    if (!canPublish()) return null;
    published = await deps.write(saved.filePath, markdown, canPublish) !== false;
    return published ? saved.filePath : null;
  } catch (error) { failure = error; throw error; }
  finally {
    if (!published && directoryCreated) {
      const errors: unknown[] = [];
      for (const path of owned) try { await deps.files!.unlink(path); } catch (error) { errors.push(error); }
      try { await deps.files!.removeDirectory(folder); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Markdown export failed; companion image cleanup incomplete', { cause: failure });
    }
  }
}
