// Settings → Appearance → Terminal icons: rules naming a program and the icon a terminal
// shows while it runs. The runtime matches the rules (terminal_agents.rs) and validates the
// bounds (settings_services.rs); these helpers keep the settings editor small.
import type { TerminalIconImage, TerminalIconRule, TerminalIconSettings } from '@threadterm/protocol';

export const MAX_TERMINAL_ICON_RULES = 50;
export const MAX_TERMINAL_ICON_IMAGES = 30;
export const MAX_TERMINAL_ICON_BYTES = 64 * 1024;
export const MAX_TERMINAL_ICON_MATCH = 64;
export const TERMINAL_ICON_ACCEPT = '.svg,.png,.webp,.jpg,.jpeg,.gif';
const ICON_TYPES = new Set(['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg', 'image/gif']);

const isText = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The saved rules and images; empty lists when the setting is missing or malformed. */
export function parseTerminalIcons(value: unknown): TerminalIconSettings {
  const record = isRecord(value) ? value : {};
  const images = (Array.isArray(record.images) ? record.images : [])
    .filter((image): image is TerminalIconImage => isRecord(image) && isText(image.id) && isText(image.name) && isText(image.src));
  const rules = (Array.isArray(record.rules) ? record.rules : [])
    .filter((rule): rule is TerminalIconRule => isRecord(rule) && isText(rule.id) && isText(rule.match) && isText(rule.icon));
  return { rules, images };
}

/** A short readable id that no item in `taken` uses. */
export function uniqueIconId(base: string, taken: readonly { id: string }[]): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'icon';
  const used = new Set(taken.map(item => item.id));
  let id = stem;
  for (let n = 2; used.has(id); n++) id = `${stem}-${n}`;
  return id;
}

/** Uploaded images live only while a rule uses them, so there is nothing separate to manage. */
export function withoutUnusedImages(settings: TerminalIconSettings): TerminalIconSettings {
  const used = new Set(settings.rules.filter(rule => rule.icon.startsWith('image:')).map(rule => rule.icon.slice('image:'.length)));
  return { rules: settings.rules, images: settings.images.filter(image => used.has(image.id)) };
}

/** Why a chosen file cannot be an icon, if it cannot. */
export function iconFileProblem(file: { type: string; size: number }): 'type' | 'size' | undefined {
  if (!ICON_TYPES.has(file.type)) return 'type';
  if (file.size > MAX_TERMINAL_ICON_BYTES) return 'size';
  return undefined;
}

/** The file's name without its extension, as the icon's label. */
export function iconFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim().slice(0, 60) || 'Icon';
}
