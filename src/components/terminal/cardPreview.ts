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
}

const DEFAULT_MAX_LINES = 5;
const MAX_LINE_LENGTH = 180;

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

const STATUS_PATTERNS: RegExp[] = [
  /\b(esc|ctrl\+c|ctrl-c|shift\+tab|tab|enter)\b.*\b(cancel|quit|send|navigate|switch|close)\b/i,
  /\b(press|type)\b.+\b(to|for)\b.+\b(continue|cancel|quit|submit|send)\b/i,
  /\b(model|tokens?|context|cost|cwd|working directory|auto-?accept)\s*[:=]/i,
  /\b(claude code|codex|gemini)\b\s*$/i,
  /\S*(?:\.zsh|\.zshrc|\.zprofile|\.bashrc|\.bash_profile|\.profile):\d+:\s+command not found:\s+compdef\b/i,
  /^[-_=\s]{6,}$/,
];

export function buildCardPreview(
  card: Pick<TerminalCard, 'lastReplyPreview' | 'lastOutput' | 'status' | 'terminalType'>,
  options: BuildCardPreviewOptions = {},
): CardPreview {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const replyLines = cleanPreviewLines(card.lastReplyPreview, maxLines);
  const outputLines = replyLines.lines.length > 0
    ? replyLines
    : cleanPreviewLines(card.lastOutput, maxLines);
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
    /^\s*[$>#]\s+/.test(line) ||
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

function cleanPreviewLines(raw: string | undefined, maxLines: number): { lines: string[]; hiddenLineCount: number } {
  const sourceLines = splitCandidateLines(raw);
  const cleaned = sourceLines
    .map(normalizePreviewLine)
    .filter((line): line is string => Boolean(line))
    .filter((line) => !isNoiseLine(line));
  const deduped = dedupePreviewLines(cleaned);
  const lines = deduped
    .slice(-maxLines)
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line));

  return {
    lines,
    hiddenLineCount: Math.max(0, sourceLines.length - lines.length),
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

    if (prev && (signature(prev) === key || sharedSuffixLen(prev, line) >= 12)) {
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

function sharedSuffixLen(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
