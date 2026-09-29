import type { ILink, Terminal } from '@xterm/xterm';
import type { FileReference } from '@threadterm/protocol';
import { extractFileReferences } from '../fileReferences';

type CellPosition = { x: number; y: number };
const MAX_PHYSICAL_LINES = 8;
const MAX_TEXT = 4096;

/** Scope modifier feedback to a currently hovered xterm file link. */
export function createTerminalFileLinkInteraction(element: HTMLElement) {
  let hovered: ILink | undefined;
  let modifierHeld = false;
  const show = (link: ILink | undefined, active: boolean) => {
    if (!link?.decorations) return;
    // xterm tracks changes to these properties after the link is provided.
    link.decorations.pointerCursor = active;
    link.decorations.underline = active;
  };
  const clear = () => {
    show(hovered, false);
    hovered = undefined;
  };
  const onKey = (event: KeyboardEvent) => {
    const next = event.ctrlKey || event.metaKey;
    if (next === modifierHeld) return;
    modifierHeld = next;
    show(hovered, next);
  };
  const onBlur = () => { modifierHeld = false; clear(); };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  element.addEventListener('mouseleave', clear);
  return {
    hover(link: ILink, event: MouseEvent) {
      if (hovered !== link) clear();
      hovered = link;
      modifierHeld = event.ctrlKey || event.metaKey;
      show(link, modifierHeld);
    },
    leave(link: ILink) { if (hovered === link) clear(); },
    dispose() {
      clear();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      element.removeEventListener('mouseleave', clear);
    },
  };
}

export type TerminalFileLinkInteraction = ReturnType<typeof createTerminalFileLinkInteraction>;

/**
 * xterm's linkifier maps mouse coordinates itself. A CSS `zoom` ancestor can
 * make that mapping disagree with the painted grid, so local-file Ctrl/Meta
 * links get a small, public-buffer-derived hit layer. It exists only while the
 * modifier is held; normal terminal selection and mouse protocols stay xterm's.
 */
export function createTerminalFileLinkHitArea(terminal: Terminal, openFile: (reference: FileReference) => void) {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return { dispose() {} };
  const overlay = document.createElement('div');
  overlay.className = 'terminal-file-link-hit-area';
  overlay.setAttribute('aria-hidden', 'true');
  screen.appendChild(overlay);
  let modifierHeld = false;
  let frame = 0;
  const hits = new Map<string, HTMLButtonElement>();
  let activeLinks = new Map<string, ILink>();
  const isVisible = () => screen.getClientRects().length > 0;
  const clear = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    activeLinks.clear(); hits.clear(); overlay.replaceChildren();
  };
  const render = () => {
    frame = 0;
    if (!modifierHeld || !isVisible()) return;
    const buffer = terminal.buffer.active;
    const first = buffer.viewportY + 1;
    const last = first + terminal.rows - 1;
    const links = new Map<string, ILink>();
    for (let line = first; line <= last; line++) {
      for (const link of terminalFileLinks(terminal, line, openFile)) {
        const key = `${link.range.start.x}:${link.range.start.y}:${link.range.end.x}:${link.range.end.y}:${link.text}`;
        links.set(key, link);
      }
    }
    activeLinks = links;
    const visible = new Set<string>();
    for (const link of links.values()) {
      const linkKey = `${link.range.start.x}:${link.range.start.y}:${link.range.end.x}:${link.range.end.y}:${link.text}`;
      const startY = Math.max(link.range.start.y, first);
      const endY = Math.min(link.range.end.y, last);
      for (let y = startY; y <= endY; y++) {
        const startX = y === link.range.start.y ? link.range.start.x - 1 : 0;
        const endX = y === link.range.end.y ? link.range.end.x : terminal.cols;
        if (endX <= startX) continue;
        const key = `${linkKey}\u0000${y}`;
        visible.add(key);
        let hit = hits.get(key);
        if (!hit) {
          hit = document.createElement('button');
          hit.type = 'button';
          hit.tabIndex = -1;
          hit.className = 'terminal-file-link-hit';
          const stop = (event: MouseEvent) => event.stopPropagation();
          // The hit target is not a keyboard control. Keep the existing terminal
          // focus when opening fails or opens a passive preview alongside it.
          hit.addEventListener('mousedown', event => { event.preventDefault(); stop(event); });
          hit.addEventListener('mouseup', stop);
          hit.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const current = activeLinks.get(key.slice(0, key.lastIndexOf('\u0000')));
            if ((event.ctrlKey || event.metaKey) && current) current.activate(event, current.text);
          });
          hits.set(key, hit);
          overlay.appendChild(hit);
        }
        hit.style.left = `${startX / terminal.cols * 100}%`;
        hit.style.top = `${(y - first) / terminal.rows * 100}%`;
        hit.style.width = `${(endX - startX) / terminal.cols * 100}%`;
        hit.style.height = `${100 / terminal.rows}%`;
      }
    }
    for (const [key, hit] of hits) if (!visible.has(key)) { hit.remove(); hits.delete(key); }
  };
  const schedule = () => {
    if (modifierHeld && isVisible() && !frame) frame = requestAnimationFrame(render);
  };
  const setModifier = (event?: KeyboardEvent | MouseEvent) => {
    const next = Boolean(event && (event.ctrlKey || event.metaKey));
    if (next === modifierHeld) return;
    modifierHeld = next;
    overlay.classList.toggle('is-modifier-held', modifierHeld);
    if (modifierHeld && isVisible()) render();
    else clear();
  };
  const onKey = (event: KeyboardEvent) => setModifier(event);
  const onBlur = () => { modifierHeld = false; overlay.classList.remove('is-modifier-held'); clear(); };
  const onMouseMove = (event: MouseEvent) => setModifier(event);
  const renderDisposable = terminal.onRender(schedule);
  const scrollDisposable = terminal.onScroll(schedule);
  const resizeDisposable = terminal.onResize(schedule);
  const visibilityObserver = new ResizeObserver(schedule); visibilityObserver.observe(screen);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  screen.addEventListener('mousemove', onMouseMove);
  return {
    dispose() {
      clear();
      renderDisposable.dispose(); scrollDisposable.dispose(); resizeDisposable.dispose();
      visibilityObserver.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      screen.removeEventListener('mousemove', onMouseMove);
      overlay.remove();
    },
  };
}

/** Inspect xterm's rendered cells, never raw PTY bytes or ANSI escapes. */
export function terminalFileLinks(terminal: Terminal, lineNumber: number, openFile: (reference: FileReference) => void, interaction?: TerminalFileLinkInteraction): ILink[] {
  const buffer = terminal.buffer.active;
  const target = lineNumber - 1;
  if (target < 0 || !buffer.getLine(target)) return [];
  let first = target;
  while (first > 0 && target - first + 1 < MAX_PHYSICAL_LINES && buffer.getLine(first)?.isWrapped) first--;
  let last = target;
  while (last + 1 < buffer.length && last - first + 1 < MAX_PHYSICAL_LINES && buffer.getLine(last + 1)?.isWrapped) last++;
  // A bounded window is only safe if it contains the entire logical line.
  // A partial prefix/tail could look like a different, valid local path.
  if (buffer.getLine(first)?.isWrapped || buffer.getLine(last + 1)?.isWrapped) return [];
  let text = '';
  const starts: CellPosition[] = [];
  const ends: CellPosition[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < Math.min(terminal.cols, line.length); x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      if (text.length + chars.length > MAX_TEXT) return [];
      text += chars;
      for (let index = 0; index < chars.length; index++) {
        starts.push({ x: x + 1, y: y + 1 });
        ends.push({ x: x + cell.getWidth(), y: y + 1 });
      }
    }
  }
  return extractFileReferences(text).flatMap(candidate => {
    const start = starts[candidate.start];
    const end = ends[candidate.end - 1];
    if (!start || !end || start.y > lineNumber || end.y < lineNumber) return [];
    const reference = { path: candidate.path, ...(candidate.line ? { line: candidate.line } : {}), ...(candidate.column ? { column: candidate.column } : {}) };
    const link: ILink = {
      text: text.slice(candidate.start, candidate.end),
      range: { start, end },
      activate: (event: MouseEvent) => { if (event.ctrlKey || event.metaKey) openFile(reference); },
      hover: (event: MouseEvent) => interaction?.hover(link, event),
      leave: () => interaction?.leave(link),
      decorations: { pointerCursor: false, underline: false },
    };
    return [link];
  });
}
