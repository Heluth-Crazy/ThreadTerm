/**
 * searchAcrossBlocks — pure cross-card block matcher.
 *
 * Stage 5.1 spec: scope = current cards' blocks (command, output, cwd,
 * timestamp). Output is left to a future iteration; for now we match on
 * command / cwd / project (name + path) and return the matching block
 * along with its host card.
 *
 * Pure function; safe to call from a Web Worker.
 */
import type { Block, TerminalCard } from '../../types/terminal';

export type SearchField = 'command' | 'cwd' | 'project' | 'output';

export interface SearchMatch {
  block: Block;
  card: TerminalCard;
  /** Which field was matched first (priority: command → cwd → project → output). */
  field: SearchField;
  /** When `field === 'output'`, the specific line in the output that matched.
   *  Undefined for command / cwd / project matches. */
  matchedLine?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function searchAcrossBlocks(
  cards: TerminalCard[],
  blocks: Record<string, Block[]>,
  query: string,
  limit: number,
): SearchMatch[] {
  const q = query.trim();
  if (!q) return [];
  const re = new RegExp(escapeRegex(q), 'i');

  const cardById = new Map<string, TerminalCard>();
  for (const c of cards) cardById.set(c.id, c);

  const out: SearchMatch[] = [];

  for (const cardId of Object.keys(blocks)) {
    const card = cardById.get(cardId);
    if (!card) continue;
    const list = blocks[cardId];
    for (const b of list) {
      let field: SearchField | null = null;
      let matchedLine: string | undefined;
      if (re.test(b.command)) field = 'command';
      else if (re.test(b.cwd)) field = 'cwd';
      else if (re.test(card.projectName) || re.test(card.projectPath)) field = 'project';
      else if (b.output && re.test(b.output)) {
        field = 'output';
        // Task 5 — surface the matched output line so the UI can show it
        // under the command. Split on \n; the matcher is already case-
        // insensitive via the shared `re`.
        const lines = b.output.split('\n');
        matchedLine = lines.find((l) => re.test(l));
      }
      if (field) {
        out.push({ block: b, card, field, matchedLine });
        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}
