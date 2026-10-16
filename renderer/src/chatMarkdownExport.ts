import type { ChatItem, UsageRecord } from '@threadterm/protocol';
import { hasRedactedBrowserResult } from './browserToolActivity';
import { describeTool, toolEntriesForItems, toolSummary, toolSummaryText } from './toolActivity';
import { formatChatDuration } from './chatPresentation';
export type ChatExportMeta = { title: string; provider: string; model?: string; createdAt: string; durationMs?: number; tokens?: { input?: number; output?: number; total?: number }; includeThinking?: boolean; locale?: 'en' | 'zh-CN' };
export function chatExportUsage(records: readonly UsageRecord[], sessionId: string): Pick<ChatExportMeta, 'model' | 'tokens'> {
  const rows = records.filter(record => record.sessionId === sessionId);
  if (!rows.length) return {};
  const sum = (field: 'inputTokens' | 'outputTokens') => rows.every(row => typeof row[field] === 'number' && Number.isFinite(row[field])) ? rows.reduce((total, row) => total + row[field]!, 0) : undefined;
  const input = sum('inputTokens'), output = sum('outputTokens');
  const latestModel = rows.reduce<UsageRecord | undefined>((latest, row) => row.model && (!latest || row.recordedAt > latest.recordedAt) ? row : latest, undefined)?.model;
  return { model: latestModel, tokens: { input, output, total: input !== undefined && output !== undefined ? input + output : undefined } };
}
const html = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const line = (text: string) => text.replace(/[\r\n]/g, ' ').replace(/([\\`*_{}\[\]<>#])/g, '\\$1');
const fileImage = (path: string) => `![Image](<${path.replace(/[%<>\r\n]/g, char => encodeURIComponent(char))}>)`;
const localRasterPath = (path: string) => !/[\x00-\x1f\x7f]/.test(path) && !/^[/\\]{2}/.test(path) && (!/^[a-z][a-z0-9+.-]*:/i.test(path) || /^[a-z]:[/\\]/i.test(path)) && /\.(?:png|jpe?g|gif|webp)$/i.test(path);
const imageData = /<?data:image\/[^;\s<>]+;base64,[a-z0-9+/=]+>?/gi;
export type ChatExportImage = { name: string; dataUrl: string };
/** Companion assets are collected only on an explicit export, in transcript order. */
export function chatMarkdownExportBundle(items: readonly ChatItem[], meta: ChatExportMeta, assetToken: string): { markdown: string; images: ChatExportImage[]; assetToken: string } {
  const images: ChatExportImage[] = [], references = new Map<string, string>();
  const collect = (value: unknown) => {
    if (typeof value !== 'string' || references.has(value)) return;
    const match = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.exec(value);
    if (!match) return;
    if (images.length >= 1000) throw new Error('Too many images to export. / 导出的图片数量过多。');
    const name = `image-${images.length + 1}.${match[1]!.toLowerCase()}`;
    images.push({ name, dataUrl: value }); references.set(value, `${assetToken}/${name}`);
  };
  for (const item of items) if (item.role === 'user' || item.role === 'assistant') for (const part of item.parts) {
    if (hasRedactedBrowserResult(part)) continue;
    if (part.text?.includes(assetToken)) throw new Error('Image export token collision');
    if (part.type === 'thinking' && !meta.includeThinking) continue;
    if (part.type === 'text' || part.type === 'error') for (const match of part.text?.matchAll(imageData) ?? []) collect(match[0].replace(/^<|>$/g, ''));
    const data = part.data && typeof part.data === 'object' ? part.data as Record<string, unknown> : {};
    if (Array.isArray(data.images)) for (const image of data.images) collect(typeof image === 'string' ? image : image && typeof image === 'object' ? (image as Record<string, unknown>).path : undefined);
  }
  return { markdown: chatMarkdownExport(items, meta, references), images, assetToken };
}
/** Linear accumulation keeps source Markdown and never embeds image bytes. */
export function chatMarkdownExport(items: readonly ChatItem[], meta: ChatExportMeta, imageReferences?: ReadonlyMap<string, string>): string {
  const copy = (en: string, zh: string) => meta.locale === 'zh-CN' ? zh : en;
  const parts = [`# ${line(meta.title)}\n`, `${copy('Provider', '提供方')}: ${line(meta.provider)}`, `${copy('Model', '模型')}: ${line(meta.model || copy('Not reported', '未报告'))}`, `${copy('Created', '创建时间')}: ${line(meta.createdAt)}`, `${copy('Duration', '耗时')}: ${meta.durationMs !== undefined ? formatChatDuration(meta.durationMs, meta.locale === 'zh-CN') : copy('Not reported', '未报告')}`];
  const tokens = meta.tokens;
  parts.push(`${copy('Tokens', '令牌')}: ${tokens ? [tokens.input !== undefined ? `${copy('input', '输入')} ${tokens.input}` : '', tokens.output !== undefined ? `${copy('output', '输出')} ${tokens.output}` : '', tokens.total !== undefined ? `${copy('total', '总计')} ${tokens.total}` : ''].filter(Boolean).join(' · ') || copy('Not reported', '未报告') : copy('Not reported', '未报告')}`, '');
  let rows: ChatItem[] = [], turnKey: string | undefined, fallbackTurn = 0;
  const flush = () => {
    const entries = toolEntriesForItems(rows);
    if (entries.length) {
      parts.push(`${copy('Tool activity', '工具执行')}: ${toolSummaryText(toolSummary(entries), copy)}`, '', `<details>\n<summary>${copy('Tool details', '工具详情')}</summary>\n<ul>`);
      for (const entry of entries) { const title = describeTool(entry.part, copy); parts.push(`<li>${html([title.name, title.detail].filter(Boolean).join(' · '))}</li>`); }
      parts.push('</ul>\n</details>', '');
    }
    rows = [];
  };
  for (const item of items) {
    if (item.role === 'user') fallbackTurn++;
    const key = item.turnId ?? `legacy:${fallbackTurn}`;
    if (turnKey !== key) { flush(); turnKey = key; }
    rows.push(item);
    const content: string[] = [];
    for (const part of item.parts) {
      if (hasRedactedBrowserResult(part)) continue;
      if (part.type === 'text' || part.type === 'error') {
        if (part.text) content.push(part.text.replace(imageData, match => { const path = imageReferences?.get(match.replace(/^<|>$/g, '')); return path ? `<${path}>` : '[image omitted]'; }));
      } else if (part.type === 'thinking' && meta.includeThinking && part.text) content.push(`<details>\n<summary>${copy('Thinking', '思考过程')}</summary>\n<pre>${html(part.text.replace(imageData, '[image omitted]'))}</pre>\n</details>`);
      if (part.type === 'thinking' && !meta.includeThinking) continue;
      const data = part.data && typeof part.data === 'object' ? part.data as Record<string, unknown> : {};
      if (Array.isArray(data.images)) for (const image of data.images) {
        const path = typeof image === 'string' ? image : image && typeof image === 'object' ? (image as Record<string, unknown>).path : undefined;
        if (typeof path === 'string' && imageReferences?.has(path)) content.push(fileImage(imageReferences.get(path)!));
        else if (typeof path === 'string' && localRasterPath(path)) content.push(fileImage(path));
        else content.push(copy('[Image omitted: no local raster reference]', '[图片已省略：没有本地图像路径]'));
      }
    }
    if (content.length && ['user', 'assistant'].includes(item.role)) parts.push(`## ${item.role === 'user' ? copy('User', '用户') : copy('Assistant', '助手')}`, '', ...content, '');
  }
  flush(); return parts.join('\n') + '\n';
}
