// Shared ANSI/control stripping for card summaries and preview cleanup.
// Carriage returns are deliberately kept here because callers use them
// differently: card history removes them, while preview parsing turns them
// into line boundaries.
const ANSI_AND_CONTROL_PATTERN = [
  '\\x1b\\[[0-?]*[ -/]*[@-~]',
  '\\x1b[\\]PX^_][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
  '\\x1b[\\x20-\\x2f]*[\\x30-\\x7e]',
  '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]',
].join('|');
const ANSI_AND_CONTROL_RE = new RegExp(ANSI_AND_CONTROL_PATTERN, 'g');
const ANSI_CONTROL_AND_CR_RE = new RegExp(`${ANSI_AND_CONTROL_PATTERN}|\\r`, 'g');
const ESC = '\x1b';
const MIN_RAW_TAIL_WINDOW = 4_096;

export function stripAnsiAndControlCharacters(input: string): string {
  return input.replace(ANSI_AND_CONTROL_RE, '');
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_CONTROL_AND_CR_RE, '');
}

type PendingAnsiState =
  | 'text'
  | 'escape'
  | 'csi'
  | 'string'
  | 'string-escape'
  | 'escape-intermediate';

export interface AnsiTailSanitizer {
  push: (input: string, limit: number) => string;
  reset: () => void;
}

function isStringControlIntroducer(code: number): boolean {
  return code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

function findEscapeSequenceEnd(input: string, escapeIndex: number): number | null {
  const next = input.charCodeAt(escapeIndex + 1);
  if (Number.isNaN(next)) return null;

  if (next === 0x5b) {
    for (let index = escapeIndex + 2; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return null;
  }

  if (isStringControlIntroducer(next)) {
    for (let index = escapeIndex + 2; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code === 0x07) return index + 1;
      if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
    }
    return null;
  }

  if (next >= 0x20 && next <= 0x2f) {
    for (let index = escapeIndex + 2; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0x20 && code <= 0x2f) continue;
      return code >= 0x30 && code <= 0x7e ? index + 1 : escapeIndex + 1;
    }
    return null;
  }

  return next >= 0x30 && next <= 0x7e ? escapeIndex + 2 : escapeIndex + 1;
}

function prependTail(current: string, segment: string, limit: number): string {
  const remaining = limit - current.length;
  if (!segment || remaining <= 0) return current;
  const prefix = segment.length > remaining ? segment.slice(-remaining) : segment;
  return `${prefix}${current}`;
}

function stripAnsiTailRange(
  input: string,
  rangeStart: number,
  rangeEnd: number,
  limit: number,
): string {
  let tail = '';
  let end = rangeEnd;
  const rawWindow = Math.max(MIN_RAW_TAIL_WINDOW, limit * 4);

  while (end > rangeStart && tail.length < limit) {
    const start = Math.max(rangeStart, end - rawWindow);
    const precedingEscape = input.lastIndexOf(ESC, start - 1);
    if (precedingEscape >= rangeStart) {
      const sequenceEnd = findEscapeSequenceEnd(input, precedingEscape);
      if (sequenceEnd === null || sequenceEnd > start) {
        if (sequenceEnd !== null && sequenceEnd < end) {
          tail = prependTail(
            tail,
            stripAnsi(input.slice(sequenceEnd, end)),
            limit,
          );
        }
        end = precedingEscape;
        continue;
      }
    }

    tail = prependTail(tail, stripAnsi(input.slice(start, end)), limit);
    end = start;
  }

  return tail;
}

function pendingStateAtEnd(
  input: string,
  start: number,
): { visibleEnd: number; state: PendingAnsiState } {
  const escapeIndex = input.lastIndexOf(ESC);
  if (escapeIndex < start) return { visibleEnd: input.length, state: 'text' };

  const next = input.charCodeAt(escapeIndex + 1);
  if (Number.isNaN(next)) return { visibleEnd: escapeIndex, state: 'escape' };

  if (next === 0x5b) {
    return findEscapeSequenceEnd(input, escapeIndex) === null
      ? { visibleEnd: escapeIndex, state: 'csi' }
      : { visibleEnd: input.length, state: 'text' };
  }

  if (isStringControlIntroducer(next)) {
    if (findEscapeSequenceEnd(input, escapeIndex) !== null) {
      return { visibleEnd: input.length, state: 'text' };
    }
    return {
      visibleEnd: escapeIndex,
      state: input.endsWith(ESC) ? 'string-escape' : 'string',
    };
  }

  if (next >= 0x20 && next <= 0x2f) {
    return findEscapeSequenceEnd(input, escapeIndex) === null
      ? { visibleEnd: escapeIndex, state: 'escape-intermediate' }
      : { visibleEnd: input.length, state: 'text' };
  }

  return { visibleEnd: input.length, state: 'text' };
}

function consumePendingPrefix(
  input: string,
  initialState: PendingAnsiState,
): { offset: number; state: PendingAnsiState } {
  let state = initialState;
  let offset = 0;

  while (offset < input.length && state !== 'text') {
    if (state === 'escape') {
      const code = input.charCodeAt(offset);
      offset += 1;
      if (code === 0x5b) state = 'csi';
      else if (isStringControlIntroducer(code)) state = 'string';
      else if (code >= 0x20 && code <= 0x2f) state = 'escape-intermediate';
      else state = 'text';
      continue;
    }

    if (state === 'csi') {
      while (offset < input.length) {
        const code = input.charCodeAt(offset);
        offset += 1;
        if (code >= 0x40 && code <= 0x7e) {
          state = 'text';
          break;
        }
      }
      continue;
    }

    if (state === 'escape-intermediate') {
      while (offset < input.length) {
        const code = input.charCodeAt(offset);
        offset += 1;
        if (code >= 0x20 && code <= 0x2f) continue;
        state = 'text';
        break;
      }
      continue;
    }

    if (state === 'string-escape') {
      const code = input.charCodeAt(offset);
      offset += 1;
      state = code === 0x5c ? 'text' : 'string';
      continue;
    }

    const bellIndex = input.indexOf('\x07', offset);
    const escapeIndex = input.indexOf(ESC, offset);
    if (bellIndex === -1 && escapeIndex === -1) {
      return { offset: input.length, state: 'string' };
    }
    if (bellIndex !== -1 && (escapeIndex === -1 || bellIndex < escapeIndex)) {
      offset = bellIndex + 1;
      state = 'text';
    } else {
      offset = escapeIndex + 1;
      state = 'string-escape';
    }
  }

  return { offset, state };
}

/**
 * Produce the same cleaned text as `stripAnsi(input).slice(-limit)` without
 * allocating or scanning the full cleaned copy. It walks backward in bounded
 * windows and moves a window to a verified control-sequence boundary before
 * cleaning it, so a long OSC/DCS payload cannot leak merely because its
 * opening escape sits before the retained tail.
 */
export function stripAnsiTail(input: string, limit: number): string {
  if (!input || limit <= 0) return '';
  return stripAnsiTailRange(input, 0, input.length, limit);
}

/**
 * Stateful companion for output chunks that may split an ANSI sequence.
 * Only the parser state is retained; control payloads are never buffered.
 */
export function createAnsiTailSanitizer(): AnsiTailSanitizer {
  let pendingState: PendingAnsiState = 'text';

  return {
    push(input, limit) {
      if (!input || limit <= 0) return '';

      const prefix = consumePendingPrefix(input, pendingState);
      pendingState = prefix.state;
      if (pendingState !== 'text' || prefix.offset >= input.length) return '';

      const trailing = pendingStateAtEnd(input, prefix.offset);
      pendingState = trailing.state;
      return stripAnsiTailRange(input, prefix.offset, trailing.visibleEnd, limit);
    },
    reset() {
      pendingState = 'text';
    },
  };
}
