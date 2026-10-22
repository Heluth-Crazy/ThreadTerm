import type { SVGProps } from 'react';
import { Icon } from '../components/PrototypeIcon';

// Workbench-only glyphs drawn on the same 24px grid, stroke and caps as the approved prototype
// icons (`.ico`), which stay immutable in PrototypeIcon. Static markup only; never user text.
const glyphs: Record<string, string> = {
 'arrow-left': '<path d="M20 12H4m7-7-7 7 7 7"/>',
 'arrow-right': '<path d="M4 12h16m-7-7 7 7-7 7"/>',
 tune: '<path d="M3 7h3m6 0h9M3 17h9m6 0h3"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
 'zoom-in': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M7.5 10.5h6m-3-3v6"/>',
 'zoom-out': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M7.5 10.5h6"/>',
 screenshot: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
 comment: '<path d="M21 14a3 3 0 0 1-3 3H9l-6 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z"/><path d="M7 8h10M7 12h7"/>',
 // People for agent access; the prototype `agents` glyph is not part of every build of PrototypeIcon.
 'agent-access': '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14 16a5 5 0 0 1 7 4"/>',
 // The + sits outside the outline at the lower right: a + enclosed in a 16px outline antialiased into a grey blob.
 'file-plus': '<path d="M12 21H6V3h8l4 4v4"/><path d="M14 3v4h4"/><path d="M18 14v7M14.5 17.5h7"/>',
 'folder-plus': '<path d="M11 20H3V4h7l2 2h9v5"/><path d="M18 14v7M14.5 17.5h7"/>',
 refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3l2.2 2.2"/><path d="M19.5 4v4.9h-4.9"/>',
 // Chevrons folding onto a line; a boxed minus read as "minimize" and bare chevrons as an ×.
 'collapse-all': '<path d="m8 21 4-4 4 4M8 3l4 4 4-4M5 12h14"/>',
 undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
 minus: '<path d="M5 12h14"/>',
 fetch: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M12 12v9M8 17l4 4 4-4"/>',
 pull: '<path d="M12 3v13M6 10l6 6 6-6M5 21h14"/>',
 push: '<path d="M12 21V8M6 14l6-6 6 6M5 3h14"/>',
 diff: '<path d="M12 3v10M7 8h10M7 20h10"/>',
 'chev-up': '<path d="m6 15 6-6 6 6"/>',
 checkpoint: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
};
const glyphHtml=Object.fromEntries(Object.entries(glyphs).map(([name,__html])=>[name,Object.freeze({__html})]));

/** SVG markup of a workbench glyph for DOM built outside React (e.g. CodeMirror widgets). */
export const wbIconMarkup = (name:string) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${glyphs[name] ?? ''}</svg>`;

/** Workbench icon: falls back to the prototype set for names it does not define. */
export function WbIcon({name, className, ...props}:{name:string;className?:string}&SVGProps<SVGSVGElement>) {
 const body = glyphs[name];
 if(!body) return <Icon name={name} className={className} {...props}/>;
 return <svg className={['ico', className].filter(Boolean).join(' ')} viewBox="0 0 24 24" aria-hidden="true" {...props} dangerouslySetInnerHTML={glyphHtml[name]}/>;
}
