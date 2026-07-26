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

export function stripAnsiAndControlCharacters(input: string): string {
  return input.replace(ANSI_AND_CONTROL_RE, '');
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_CONTROL_AND_CR_RE, '');
}

function appendTail(current: string, segment: string, limit: number): string {
  if (!segment || limit <= 0) return limit <= 0 ? '' : current;
  if (segment.length >= limit) return segment.slice(-limit);
  const overflow = current.length + segment.length - limit;
  return `${overflow > 0 ? current.slice(overflow) : current}${segment}`;
}

/**
 * Produce the same cleaned text as `stripAnsi(input).slice(-limit)` without
 * ever allocating the full cleaned copy. The raw input is still scanned from
 * the beginning, so a long OSC/DCS sequence cannot leak merely because its
 * opening escape sits before the retained tail.
 */
export function stripAnsiTail(input: string, limit: number): string {
  if (!input || limit <= 0) return '';

  let tail = '';
  let cursor = 0;
  for (const match of input.matchAll(ANSI_CONTROL_AND_CR_RE)) {
    const index = match.index ?? cursor;
    tail = appendTail(tail, input.slice(cursor, index), limit);
    cursor = index + match[0].length;
  }
  tail = appendTail(tail, input.slice(cursor), limit);
  return tail;
}
