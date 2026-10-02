import type { IBufferRange, ILink, Terminal } from '@xterm/xterm';
import type { FileReference } from '@threadterm/protocol';
import { fileReferenceCandidates, type FileReferenceCandidate } from '../fileReferences';

/** One UTF-16 unit of rendered text: 1-based columns `x..end` on 1-based row `y`. */
type Cell = { x: number; y: number; end: number };
type CellText = { text: string; cells: Cell[] };
type Reading = { reference: FileReference; speculative: boolean; segments: { range: IBufferRange; text: string }[]; span: [number, number] };
const MAX_PHYSICAL_LINES = 8;
const MAX_TEXT = 4096;
const VALIDATION_TTL_MS = 10_000;
const VALIDATION_CACHE_LIMIT = 512;
// Leading indentation and TUI gutters (│ ⎿) of a hard-wrapped continuation row.
const CONTINUATION_INDENT = /^[\s─-╿⎿]*/u;
const MISSING_CODES = ['file_reference_not_found', 'file_reference_not_file', 'file_reference_invalid_path', 'file_reference_uri', 'file_reference_invalid_position'];

export type FileLinkStatus = 'exists' | 'missing' | 'unknown';
export type FileLinkValidator = {
  /** The cached status, starting a lookup when there is none; `undefined` while pending. */
  peek(path: string): FileLinkStatus | undefined;
  settle(path: string): Promise<FileLinkStatus>;
  onSettled(listener: () => void): () => void;
};

/** `missing` only for answers that say the file is not there; anything else cannot be checked. */
export function fileLinkStatusOf(error: unknown): FileLinkStatus {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_CODES.some(code => message.includes(code)) ? 'missing' : 'unknown';
}

/** A bounded, briefly cached existence check shared by hover links and the Ctrl hit layer. */
export function createFileLinkValidator(check: (path: string) => Promise<FileLinkStatus>): FileLinkValidator {
  type Entry = { status?: FileLinkStatus; checkedAt: number; promise: Promise<FileLinkStatus> };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const lookup = (path: string) => {
    const cached = entries.get(path);
    if (cached && (cached.status === undefined || Date.now() - cached.checkedAt < VALIDATION_TTL_MS)) return cached;
    // Keep the previous answer while refreshing, so the Ctrl layer does not flicker.
    const entry: Entry = { status: cached?.status, checkedAt: Date.now(), promise: Promise.resolve<FileLinkStatus>('unknown') };
    entry.promise = check(path).catch(() => 'unknown' as const).then(status => {
      entry.status = status; entry.checkedAt = Date.now();
      for (const listener of listeners) listener();
      return status;
    });
    entries.delete(path); entries.set(path, entry);
    if (entries.size > VALIDATION_CACHE_LIMIT) entries.delete(entries.keys().next().value as string);
    return entry;
  };
  return {
    peek: path => lookup(path).status,
    settle: path => lookup(path).promise,
    onSettled: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

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
export function createTerminalFileLinkHitArea(terminal: Terminal, openFile: (reference: FileReference) => void, validator?: FileLinkValidator) {
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
      for (const link of terminalFileLinks(terminal, line, openFile, undefined, validator)) {
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
  const stopValidation = validator?.onSettled(schedule);
  const visibilityObserver = new ResizeObserver(schedule); visibilityObserver.observe(screen);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  screen.addEventListener('mousemove', onMouseMove);
  return {
    dispose() {
      clear();
      renderDisposable.dispose(); scrollDisposable.dispose(); resizeDisposable.dispose();
      stopValidation?.();
      visibilityObserver.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      screen.removeEventListener('mousemove', onMouseMove);
      overlay.remove();
    },
  };
}

/** The soft-wrapped logical line containing 0-based `row`, read from xterm's rendered cells. */
function logicalLine(terminal: Terminal, row: number): (CellText & { first: number; last: number }) | undefined {
  const buffer = terminal.buffer.active;
  if (row < 0 || !buffer.getLine(row)) return;
  let first = row;
  while (first > 0 && row - first + 1 < MAX_PHYSICAL_LINES && buffer.getLine(first)?.isWrapped) first--;
  let last = row;
  while (last + 1 < buffer.length && last - first + 1 < MAX_PHYSICAL_LINES && buffer.getLine(last + 1)?.isWrapped) last++;
  // A bounded window is only safe if it contains the entire logical line.
  // A partial prefix/tail could look like a different, valid local path.
  if (buffer.getLine(first)?.isWrapped || buffer.getLine(last + 1)?.isWrapped) return;
  let text = '';
  const cells: Cell[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < Math.min(terminal.cols, line.length); x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      if (text.length + chars.length > MAX_TEXT) return;
      text += chars;
      for (let index = 0; index < chars.length; index++) cells.push({ x: x + 1, y: y + 1, end: x + cell.getWidth() });
    }
  }
  return { first, last, text, cells };
}

// Claude Code, Codex and other TUIs hard-wrap long paths with a real newline and an indent,
// so xterm never marks the next row as wrapped. A candidate that crosses such a break is
// offered only as a speculative reading, for the runtime to confirm.
function reachesRightEdge(line: CellText, cols: number) {
  const last = line.cells[line.text.trimEnd().length - 1];
  return Boolean(last) && last.end >= cols - Math.min(12, Math.floor(cols / 4));
}

function joinRows(head: CellText, tail: CellText) {
  const boundary = head.text.trimEnd().length;
  const indent = CONTINUATION_INDENT.exec(tail.text)?.[0].length ?? 0;
  return { text: head.text.slice(0, boundary) + tail.text.slice(indent), cells: [...head.cells.slice(0, boundary), ...tail.cells.slice(indent)], boundary, indent };
}

/** Contiguous cell runs of `source[start, end)`; a hard-wrap join yields one run per row. */
function segments(source: CellText, start: number, end: number, cols: number) {
  const result: Reading['segments'] = [];
  let from = start;
  for (let index = start + 1; index <= end; index++) {
    const previous = source.cells[index - 1], cell = source.cells[index];
    const continues = index < end && cell && ((cell.y === previous.y && (cell.x === previous.x || cell.x === previous.end + 1))
      || (cell.y === previous.y + 1 && cell.x === 1 && previous.end >= cols));
    if (continues) continue;
    const head = source.cells[from];
    result.push({ range: { start: { x: head.x, y: head.y }, end: { x: previous.end, y: previous.y } }, text: source.text.slice(from, index) });
    from = index;
  }
  return result;
}

/** Alternative readings per location intersecting `lineNumber`, most likely first. */
function readings(terminal: Terminal, lineNumber: number): Reading[][] {
  const current = logicalLine(terminal, lineNumber - 1);
  if (!current) return [];
  const read = (source: CellText, candidate: FileReferenceCandidate, span: [number, number], speculative: boolean): Reading => ({
    reference: { path: candidate.path, ...(candidate.line ? { line: candidate.line } : {}), ...(candidate.column ? { column: candidate.column } : {}) },
    speculative,
    segments: segments(source, candidate.start, candidate.end, terminal.cols),
    span,
  });
  const groups = fileReferenceCandidates(current.text).map(group => group.map(candidate => read(current, candidate, [candidate.start, candidate.end], Boolean(candidate.speculative))));
  const attach = (joined: Reading[]) => {
    if (!joined.length) return;
    const [start, end] = joined[0].span;
    const group = groups.find(items => items.some(item => item.span[0] < end && start < item.span[1]));
    if (group) group.unshift(...joined); else groups.push(joined);
  };
  const crossing = (join: ReturnType<typeof joinRows>) => fileReferenceCandidates(join.text).flat()
    .filter(candidate => candidate.start < join.boundary && candidate.end > join.boundary);
  const next = logicalLine(terminal, current.last + 1);
  if (next && reachesRightEdge(current, terminal.cols)) {
    const join = joinRows(current, next);
    attach(crossing(join).map(candidate => read(join, candidate, [candidate.start, join.boundary], true)));
  }
  const previous = current.first > 0 ? logicalLine(terminal, current.first - 1) : undefined;
  if (previous && reachesRightEdge(previous, terminal.cols)) {
    const join = joinRows(previous, current);
    attach(crossing(join).map(candidate => read(join, candidate, [join.indent, join.indent + candidate.end - join.boundary], true)));
  }
  return groups;
}

/** The first reading the runtime has not ruled out; `null` while a lookup is pending. */
function pick(group: Reading[], status: (path: string) => FileLinkStatus | undefined): Reading | null | undefined {
  const statuses = group.map(reading => status(reading.reference.path));
  for (const [index, reading] of group.entries()) {
    const result = statuses[index];
    if (result === undefined) return null;
    if (result === 'exists' || (result === 'unknown' && !reading.speculative)) return reading;
  }
  return undefined;
}

function toLinks(chosen: (Reading | null | undefined)[], lineNumber: number, openFile: (reference: FileReference) => void, interaction?: TerminalFileLinkInteraction): ILink[] {
  const kept: Reading[] = [];
  for (const reading of chosen.filter((item): item is Reading => Boolean(item)).sort((a, b) => a.span[0] - b.span[0])) {
    if (!kept.some(item => item.span[0] < reading.span[1] && reading.span[0] < item.span[1])) kept.push(reading);
  }
  return kept.flatMap(reading => reading.segments.filter(segment => segment.range.start.y <= lineNumber && segment.range.end.y >= lineNumber).map(segment => {
    const link: ILink = {
      text: segment.text,
      range: segment.range,
      activate: (event: MouseEvent) => { if (event.ctrlKey || event.metaKey) openFile(reading.reference); },
      hover: (event: MouseEvent) => interaction?.hover(link, event),
      leave: () => interaction?.leave(link),
      decorations: { pointerCursor: false, underline: false },
    };
    return link;
  }));
}

/**
 * Inspect xterm's rendered cells, never raw PTY bytes or ANSI escapes. With a validator,
 * readings still being looked up are left out until it settles; without one, the first
 * non-speculative reading of each location is used.
 */
export function terminalFileLinks(terminal: Terminal, lineNumber: number, openFile: (reference: FileReference) => void, interaction?: TerminalFileLinkInteraction, validator?: FileLinkValidator): ILink[] {
  const status = (path: string): FileLinkStatus | undefined => validator ? validator.peek(path) : 'unknown';
  return toLinks(readings(terminal, lineNumber).map(group => pick(group, status)), lineNumber, openFile, interaction);
}

/** xterm link-provider form: waits for the runtime to settle each location's readings. */
export async function provideTerminalFileLinks(terminal: Terminal, lineNumber: number, openFile: (reference: FileReference) => void, interaction: TerminalFileLinkInteraction | undefined, validator: FileLinkValidator): Promise<ILink[]> {
  const groups = readings(terminal, lineNumber);
  const settled = new Map<string, FileLinkStatus>();
  await Promise.all(groups.flat().map(async reading => { settled.set(reading.reference.path, await validator.settle(reading.reference.path)); }));
  return toLinks(groups.map(group => pick(group, path => settled.get(path))), lineNumber, openFile, interaction);
}
