import { isLocalHtmlPreviewUrl } from '../../renderer/src/htmlPreviewUrl.js';
import { resolve, dirname } from 'node:path';
import type { PagePick, PageRect, PageSourceHint, PageTargetRef } from '@threadterm/protocol';

export const PAGE_ATTRIBUTE_KEYS = ['id', 'class', 'data-testid', 'data-test', 'data-cy', 'name', 'type', 'role', 'aria-label', 'href', 'src', 'alt', 'placeholder', 'title'] as const;
export const MAX_PAGE_SHOT_BYTES = 4 * 1024 * 1024;

export function validPageFrameName(value: unknown): value is string {
  return typeof value === 'string' && /^tt-preview-[a-z0-9-]{8,64}$/.test(value);
}

export function validPageShotId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function pageShotPath(directory: string, id: unknown, extension: 'png' | 'jpg'): string {
  if (!validPageShotId(id) || (extension !== 'png' && extension !== 'jpg')) throw new Error('Invalid page shot id or extension');
  const path = resolve(directory, `${id.toLowerCase()}.${extension}`);
  if (dirname(path) !== resolve(directory)) throw new Error('Page shot path escaped its directory');
  return path;
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid page comment object');
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some((key) => !keys.includes(key))) throw new Error('Unexpected page comment field');
  return result;
}

function string(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f-\x9f]/.test(value) || (nonempty && !value.trim())) throw new Error('Invalid page comment string');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid page comment number');
  return value;
}

function positiveInteger(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('Invalid page source position');
  return result;
}

export function pageRect(value: unknown): PageRect {
  const rect = record(value, ['x', 'y', 'width', 'height']);
  const result = { x: number(rect.x), y: number(rect.y), width: number(rect.width), height: number(rect.height) };
  if (result.width < 0 || result.height < 0) throw new Error('Invalid page rectangle');
  return result;
}

export function clipPageRect(rect: PageRect, width: number, height: number): PageRect {
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  const right = Math.max(x, Math.min(width, rect.x + rect.width));
  const bottom = Math.max(y, Math.min(height, rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function sourceHint(value: unknown): PageSourceHint {
  const source = record(value, ['file', 'line', 'column', 'framework']);
  if (typeof source.framework !== 'string' || !['react', 'vue', 'svelte', 'attribute'].includes(source.framework)) throw new Error('Invalid page source framework');
  return {
    file: string(source.file, 400, true), framework: source.framework as PageSourceHint['framework'],
    ...(source.line === undefined ? {} : { line: positiveInteger(source.line) }),
    ...(source.column === undefined ? {} : { column: positiveInteger(source.column) }),
  };
}

function strings(value: unknown, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count) throw new Error('Invalid page comment list');
  return value.map((item) => string(item, length));
}

export function sanitizePagePick(value: unknown): PagePick | null {
  if (value === null) return null;
  const pick = record(value, ['url', 'title', 'viewport', 'target']);
  const url = string(pick.url, 2048, true);
  if (!isLocalHtmlPreviewUrl(url) && (!/^https?:\/\//i.test(url) || !['http:', 'https:'].includes(new URL(url).protocol))) throw new Error('Invalid page URL');
  const title = string(pick.title, 200);
  const size = record(pick.viewport, ['width', 'height']);
  const viewport = { width: number(size.width), height: number(size.height) };
  if (viewport.width <= 0 || viewport.height <= 0 || viewport.width > 10000 || viewport.height > 10000) throw new Error('Invalid page viewport');
  const target = record(pick.target);
  const rect = clipPageRect(pageRect(target.rect), viewport.width, viewport.height);
  if (target.type === 'area') {
    record(target, ['type', 'rect', 'elements']);
    return { url, title, viewport, target: { type: 'area', rect, elements: strings(target.elements, 8, 160) } };
  }
  if (target.type !== 'element') throw new Error('Invalid page target type');
  record(target, ['type', 'selector', 'tag', 'label', 'text', 'attributes', 'html', 'rect', 'source', 'components']);
  const tag = string(target.tag, 80, true);
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error('Invalid page element tag');
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(target.attributes, PAGE_ATTRIBUTE_KEYS))) attributes[key] = string(value, 300);
  if (tag === 'input' && attributes.type?.toLowerCase() === 'password') throw new Error('Password attributes must be omitted');
  return { url, title, viewport, target: {
    type: 'element', selector: string(target.selector, 500, true), tag, label: string(target.label, 160),
    ...(target.text === undefined ? {} : { text: string(target.text, 300) }),
    attributes, html: string(target.html, 600), rect,
    ...(target.source === undefined ? {} : { source: sourceHint(target.source) }),
    ...(target.components === undefined ? {} : { components: strings(target.components, 6, 80) }),
  } };
}

export function sanitizePageTargetRef(value: unknown): PageTargetRef | undefined {
  if (value === undefined) return undefined;
  const target = record(value, ['selector', 'rect']);
  if (target.selector === undefined && target.rect === undefined) throw new Error('Empty page target reference');
  return {
    ...(target.selector === undefined ? {} : { selector: string(target.selector, 500, true) }),
    ...(target.rect === undefined ? {} : { rect: pageRect(target.rect) }),
  };
}

export function pageCaptureRect(frameValue: unknown, targetValue: unknown, viewport: { width: number; height: number }, zoom: number, content: { width: number; height: number }): PageRect | null {
  const frame = pageRect(frameValue);
  const target = pageRect(targetValue);
  if (!Number.isFinite(zoom) || zoom <= 0 || ![viewport.width, viewport.height, content.width, content.height].every((n) => Number.isFinite(n) && n > 0)) throw new Error('Invalid page capture bounds');
  const clipped = clipPageRect(target, Math.min(viewport.width, frame.width), Math.min(viewport.height, frame.height));
  const windowRect = clipPageRect({ x: (frame.x + clipped.x) * zoom, y: (frame.y + clipped.y) * zoom, width: clipped.width * zoom, height: clipped.height * zoom }, content.width, content.height);
  const x = Math.round(windowRect.x);
  const y = Math.round(windowRect.y);
  const width = Math.min(Math.floor(content.width) - x, Math.round(windowRect.width));
  const height = Math.min(Math.floor(content.height) - y, Math.round(windowRect.height));
  return width < 2 || height < 2 ? null : { x, y, width, height };
}

export function pageImageSize(width: number, height: number, max: number): { width: number; height: number } {
  if (![width, height, max].every((n) => Number.isFinite(n) && n > 0)) throw new Error('Invalid page image size');
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
