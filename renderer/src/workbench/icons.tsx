import type { SVGProps } from 'react';
import { Icon, iconMarkup, type IconName } from '../components/PrototypeIcon';

// Design Mode's markup tools, drawn on the same 24px grid, stroke and caps as the line icons (`.ico`). Every other
// workbench glyph is a line icon (PrototypeIcon, from Lucide since 2026-11-26). Static markup only; never user text.
const glyphs = {
 'mark-draw': '<path d="M4.5 16.5c2.4-5.6 4.8-7.6 6.9-4.6s4.1 2 7.6-4.4"/>',
 'mark-ellipse': '<ellipse cx="12" cy="12" rx="8" ry="5.5"/>',
 'mark-rect': '<rect x="4.5" y="6.5" width="15" height="11" rx="1.5"/>',
 'mark-arrow': '<path d="M5.5 18.5 18 6M9.5 6H18v8.5"/>',
} as const;
type Glyph = keyof typeof glyphs;
/** A name WbIcon draws: a line icon, or one of Design Mode's markup tools. */
export type WbIconName = IconName | Glyph;
const glyphHtml: Record<string, { readonly __html: string }> = Object.fromEntries(Object.entries(glyphs).map(([name, __html]) => [name, Object.freeze({ __html })]));
const isGlyph = (name: string): name is Glyph => Object.hasOwn(glyphs, name);

/** SVG markup of a workbench glyph for DOM built outside React (e.g. CodeMirror widgets). */
export const wbIconMarkup = (name: WbIconName) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${isGlyph(name) ? glyphs[name] : iconMarkup(name)}</svg>`;

/** Workbench icon: a line icon, or one of Design Mode's markup tools. */
export function WbIcon({ name, className, ...props }: { name: WbIconName; className?: string } & SVGProps<SVGSVGElement>) {
 if (!isGlyph(name)) return <Icon name={name} className={className} {...props} />;
 return <svg className={['ico', className].filter(Boolean).join(' ')} viewBox="0 0 24 24" aria-hidden="true" {...props} dangerouslySetInnerHTML={glyphHtml[name]} />;
}
