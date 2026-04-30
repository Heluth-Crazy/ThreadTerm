import type { TerminalCard, TerminalStatus } from '../../types/terminal';

export type CardPreviewKind = 'empty' | 'thinking' | 'reply' | 'waiting' | 'error' | 'shell';

export interface CardPreview {
  kind: CardPreviewKind;
  bodyLines: string[];
  hiddenLineCount: number;
  source: 'reply' | 'output' | 'none';
}

interface BuildCardPreviewOptions {
  maxLines?: number;
  maxLineLength?: number;
}

const DEFAULT_MAX_LINES = 5;
const DEFAULT_MAX_LINE_LENGTH = 320;

/* eslint-disable no-control-regex */
const ANSI_RE = new RegExp(
  [
    '\\x1b\\[[0-?]*[ -/]*[@-~]',
    '\\x1b[\\]PX^_][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    '\\x1b[\\x20-\\x2f]*[\\x30-\\x7e]',
  ].join('|'),
  'g',
);
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

const BORDER_ONLY_RE = /^[\s╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝╟╢╠╣╦╩╬━┃┏┓┗┛┠┨┯┷┿╾╼╺╸╴╶]+$/;
const EDGE_RE = /^[\s│┃║▌▐▏▕>]+|[\s│┃║▌▐▏▕]+$/g;
const SPINNER_RE = /^[\s·•●○◦▪▫■□◆◇✦✧✶✷✸✹✺✻✼✽✾✿⠁-⣿⣀-⣿⡀-⣿⢀-⣿⠁-⣿]+/u;
const DECORATION_HEAVY_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝╟╢╠╣╦╩╬━┃┏┓┗┛]/gu;
const WORD_RE = /[\p{L}\p{N}]/gu;

// Hint-style chars used by TUI shortcut bars (e.g. "⏵ approve  ⏷ scroll  ? shortcuts").
// Used both to recognise the bar and to allow the same pattern through the
// keyword regex without the chars being treated as decoration.
const TUI_HINT_KEYWORDS =
  '(?:approve|reject|scroll|shortcuts?|cancel|quit|undo|redo|switch|navigate|copy|paste|edit|toggle|continue|send|run|select|expand|collapse|menu|history)';

const STATUS_PATTERNS: RegExp[] = [
  /\b(esc|ctrl\+c|ctrl-c|shift\+tab|tab|enter)\b.*\b(cancel|quit|send|navigate|switch|close)\b/i,
  /\b(press|type)\b.+\b(to|for)\b.+\b(continue|cancel|quit|submit|send)\b/i,
  /\b(model|tokens?|context|cost|cwd|working directory|auto-?accept)\s*[:=]/i,
  /\b(claude code|codex|gemini)\b\s*$/i,
  /\.openclaw\/completions\//i,
  /\bcommand not found:\s+compdef\b/i,
  /\S*(?:\.zsh|\.zshrc|\.zprofile|\.bashrc|\.bash_profile|\.profile):\d+:\s+command not found:\s+compdef\b/i,
  /^(?:[%$>#]\s+)?(printf|echo)\b/i,
  /^[%$>#]\s+[^\s@]+@[^\s]+\s+/,
  /^[-_=\s]{6,}$/,
  // TUI shortcut hint bar: two or more "<key> <verb>" pairs separated by spaces / · / |.
  new RegExp(
    `^[\\s⏵⏷⏸⏹◀▶▲▼⌘⌃⌥⇧↑↓←→⇄⇅?]*${TUI_HINT_KEYWORDS}(?:\\s*[·|/]\\s*|\\s+)[\\s⏵⏷⏸⏹◀▶▲▼⌘⌃⌥⇧↑↓←→⇄⇅?\\w+]*${TUI_HINT_KEYWORDS}`,
    'i',
  ),
  // "? for shortcuts" / "press ? for help" hints at the bottom of the input box.
  /\?\s+(?:for\s+)?(?:shortcuts?|help|commands?|menu)\b/i,
  // Stat / cost rows: "◆ 12.4k tokens", "0 errors", "2 changes", "1.2s", etc.
  /^[\s·•●○◦▪▫■□◆◇✦✧✶✷✸✹✺✻✼✽✾✿⏵⏷]*\s*\d+(?:[.,]\d+)?\s*[kKmM]?\s*(tokens?|requests?|turns?|messages?|errors?|warnings?|changes?|edits?|diffs?|hunks?|files?|lines?|chars?|words?|seconds?|minutes?|hours?|ms|ctx|context)\b/i,
  // Model / branding status lines: "codex  gpt-5.5  main", "claude  sonnet-4.5".
  /^\s*(claude|codex|gemini)\s+(?:code\s+)?(?:gpt-|claude-|gemini-|sonnet|opus|haiku|o\d)/i,
  // Empty input cursor placeholders that survive edge stripping (e.g. "> _" → "_").
  /^_+$/,
];

const SHELL_PROMPT_RE = /^[^\s@]+@[^\s]+\s+.+?\s([%$#>])(?:\s+(.*))?$/;

export function buildCardPreview(
  card: Pick<TerminalCard, 'lastReplyPreview' | 'lastOutput' | 'status' | 'terminalType'>,
  options: BuildCardPreviewOptions = {},
): CardPreview {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const replyLines = cleanPreviewLines(card.lastReplyPreview, maxLines, maxLineLength);
  const outputLines = replyLines.lines.length > 0
    ? replyLines
    : cleanPreviewLines(card.lastOutput, maxLines, maxLineLength);
  const source = replyLines.lines.length > 0 ? 'reply' : outputLines.lines.length > 0 ? 'output' : 'none';

  return {
    kind: resolvePreviewKind(card.status, source, card.terminalType),
    bodyLines: outputLines.lines,
    hiddenLineCount: outputLines.hiddenLineCount,
    source,
  };
}

export function isTechnicalPreviewLine(line: string): boolean {
  return (
    /^\s*[%$>#]\s+/.test(line) ||
    /^(\w+:)?[~/./\\][^\s]*[/:\\]/.test(line) ||
    /\b(error|failed|exception|traceback|panic|warning)\b/i.test(line) ||
    /^[A-Z_][A-Z0-9_]*=/.test(line)
  );
}

function resolvePreviewKind(
  status: TerminalStatus,
  source: CardPreview['source'],
  terminalType: TerminalCard['terminalType'],
): CardPreviewKind {
  if (status === 'waiting') return 'waiting';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'thinking';
  if (source === 'none') return 'empty';
  if (source === 'reply' || terminalType === 'claude' || terminalType === 'codex' || terminalType === 'gemini') {
    return 'reply';
  }
  return 'shell';
}

function cleanPreviewLines(
  raw: string | undefined,
  maxLines: number,
  maxLineLength: number,
): { lines: string[]; hiddenLineCount: number } {
  const sourceLines = splitCandidateLines(raw);
  const cleaned = sourceLines
    .map(normalizePreviewLine)
    .filter((line): line is string => Boolean(line))
    .filter((line) => !isNoiseLine(line));
  const deduped = dedupePreviewLines(cleaned);
  const lines = deduped
    .slice(-maxLines)
    .map((line) => (line.length > maxLineLength ? `${line.slice(0, maxLineLength - 1)}…` : line));

  return {
    lines,
    hiddenLineCount: Math.max(0, deduped.length - lines.length),
  };
}

function splitCandidateLines(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(ANSI_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normalizePreviewLine(input: string): string | null {
  let line = input.trim();
  if (!line) return null;
  if (BORDER_ONLY_RE.test(line)) return null;

  const shellPrompt = line.match(SHELL_PROMPT_RE);
  if (shellPrompt) {
    const command = shellPrompt[2]?.trim();
    if (!command) return null;
    line = `${shellPrompt[1]} ${command}`;
  }

  line = line.replace(EDGE_RE, '').trim();
  line = line.replace(SPINNER_RE, '').trim();
  line = line.replace(/^[-–—:;,.|/\\]+/, '').trim();
  line = line.replace(/\s{2,}/g, ' ');

  if (!line || BORDER_ONLY_RE.test(line)) return null;
  return line;
}

function isNoiseLine(line: string): boolean {
  if (STATUS_PATTERNS.some((pattern) => pattern.test(line))) return true;

  const decorationCount = (line.match(DECORATION_HEAVY_RE) ?? []).length;
  const wordCount = (line.match(WORD_RE) ?? []).length;
  if (decorationCount > 0 && decorationCount >= wordCount) return true;

  // Repaint artifacts often leave very short punctuation-heavy fragments.
  if (line.length <= 3 && wordCount === 0) return true;

  return false;
}

function dedupePreviewLines(lines: string[]): string[] {
  const out: string[] = [];
  const seenRecent = new Set<string>();

  for (const line of lines) {
    const key = signature(line);
    const prev = out[out.length - 1];

    if (prev && signature(prev) === key) {
      out[out.length - 1] = line;
      continue;
    }

    if (seenRecent.has(key)) continue;
    out.push(line);
    seenRecent.add(key);

    if (out.length > 20) {
      seenRecent.delete(signature(out[out.length - 21]));
    }
  }

  return out;
}

function signature(line: string): string {
  return line
    .toLowerCase()
    .replace(SPINNER_RE, '')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds?|tokens?|%)/g, '#')
    .replace(/[•·●○◦▪▫■□◆◇✦✧✶✷✸✹✺✻✼✽✾✿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
