import type { Token, TokensList } from 'marked';
import { lexChatMarkdown } from './chatMath';

/** How ChatView `CodexMarkdownPart` renders one snapshot of a streaming reply:
 * - `blocks`: the text split into its top-level Markdown blocks (each with the blank lines after it; blank lines before
 *   the first block belong to it), rendered one by one. The whole text is lexed again for every snapshot, so a later
 *   delta may merge, split or change any block (an open `$$` or code fence, a table's delimiter row, a setext
 *   underline); the caller only reuses the rendering of a block whose source is unchanged. Rendering the blocks apart
 *   gives the same HTML as rendering the whole text.
 * - `whole`: render this reply as one text from now on. A block's meaning depends on text elsewhere or its HTML cannot
 *   be sanitized on its own: link reference definitions (`[x]: url`) change how other blocks render; raw HTML anywhere,
 *   block or inline, is repaired differently by the HTML parser when paragraphs are parsed apart. Or the lexer's
 *   sources do not add up to the text (an empty list item inside a list, inline `$$…$$` in a paragraph that is
 *   followed by another block). Switching once, for good, keeps the reply from changing structure back and forth. */
export type StreamingSplit = { kind: 'blocks'; blocks: string[] } | { kind: 'whole' };

export function splitStreamingMarkdown(text: string): StreamingSplit {
  // The lexer reads `\r\n` and `\r` as `\n`; so does rendering the whole text.
  const source = text.replace(/\r\n?/g, '\n');
  const tokens = lexChatMarkdown(source);
  if (Object.keys(tokens.links ?? {}).length || needsWholeText(tokens)) return { kind: 'whole' };
  const blocks: string[] = [];
  let leading = '';
  for (const token of tokens) {
    if (token.type === 'space') {
      if (blocks.length) blocks[blocks.length - 1] += token.raw;
      else leading += token.raw;
    } else {
      blocks.push(leading + token.raw);
      leading = '';
    }
  }
  if (leading) blocks.push(leading);
  // A token's source can differ from the text at the very end ("- " is read as "-\n"): the last block is simply the
  // rest of the text, which lexes to the same token.
  const prefix = blocks.slice(0, -1).join('');
  if (!source.startsWith(prefix)) return { kind: 'whole' };
  if (blocks.length) blocks[blocks.length - 1] = source.slice(prefix.length);
  return { kind: 'blocks', blocks };
}

function needsWholeText(tokens: TokensList | Token[]): boolean {
  for (const token of tokens) {
    if (token.type === 'html' || token.type === 'def') return true;
    const nested = token as { tokens?: Token[]; items?: { tokens?: Token[] }[]; header?: { tokens?: Token[] }[]; rows?: { tokens?: Token[] }[][] };
    if (nested.tokens && needsWholeText(nested.tokens)) return true;
    for (const item of nested.items ?? []) if (item.tokens && needsWholeText(item.tokens)) return true;
    for (const cell of nested.header ?? []) if (cell.tokens && needsWholeText(cell.tokens)) return true;
    for (const row of nested.rows ?? []) for (const cell of row) if (cell.tokens && needsWholeText(cell.tokens)) return true;
  }
  return false;
}
