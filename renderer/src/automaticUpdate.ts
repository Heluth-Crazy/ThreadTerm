import type { ChatItem } from '@threadterm/protocol';

/**
 * R14: the message ThreadTerm writes on the parent agent's behalf when a delegate has news.
 * The runtime marks its text part `automatic` (R8); the renderer reads the flag, never the
 * fixed first line, to decide how a user item is drawn. Everything below only turns the
 * model-facing English lines into the user's language — the parser never decides identity.
 */
export const AUTOMATIC_FIRST_LINE = '[ThreadTerm] Automatic delegate update, not a message from the user:';

export type Copy = (en: string, zh: string) => string;

export type AutomaticUpdate =
  | { kind: 'completed'; title: string; agent?: string }
  | { kind: 'failed'; title: string; agent?: string; error: string }
  | { kind: 'interrupted'; title: string; agent?: string }
  | { kind: 'cancel_failed'; title: string; agent?: string; error: string }
  | { kind: 'request'; title: string; agent?: string; request: string }
  | { kind: 'quiet'; title: string; agent?: string; minutes: number; tool?: string }
  | { kind: 'text'; text: string };

/** True when this text part is an automatic delegate update (run 1 sets the flag). */
export function isAutomaticText(text: string | undefined): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(AUTOMATIC_FIRST_LINE);
}

/** True when the item carries the `automatic` flag (its own text parts, not the flagless history). */
export function isAutomaticItem(item: Pick<ChatItem, 'role' | 'parts'> | undefined): boolean {
  return Boolean(item && item.role === 'user' && item.parts.some(flagged));
}

/** The flag lives on the text part; plan parts never carry it. */
function flagged(part: ChatItem['parts'][number]): boolean {
  return (part as { automatic?: boolean }).automatic === true;
}

/** The automatic text of a user item, if any. */
export function automaticText(item: Pick<ChatItem, 'role' | 'parts'> | undefined): string | undefined {
  if (!item || item.role !== 'user') return undefined;
  const text = item.parts.filter(part => flagged(part) && part.type === 'text' && part.text).map(part => part.text!).join('\n');
  return text.trim() ? text : undefined;
}

const HEAD = /^- "(.*)" \(([^,()]+), ([^)]*)\) ([\s\S]*)$/;

/**
 * The update lines of one automatic message, in order. The fixed first line and the
 * closing line are not updates and never appear. A line that matches no known shape is
 * kept as plain text without its leading bullet.
 */
export function automaticUpdates(text: string): AutomaticUpdate[] {
  const updates: AutomaticUpdate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === AUTOMATIC_FIRST_LINE || !line.startsWith('- ')) continue;
    if (line === '- ' + AUTOMATIC_FIRST_LINE) continue;
    const bullet = line.slice(2).trim();
    const head = HEAD.exec(line);
    if (!head) {
      updates.push({ kind: 'text', text: bullet });
      continue;
    }
    const [, title, agent, , rest] = head as unknown as [string, string, string, string, string];
    const value: { title: string; agent?: string } = { title, ...(agent.trim() ? { agent: agent.trim() } : {}) };
    if (rest.startsWith('completed. Read it with delegate_result.')) updates.push({ kind: 'completed', ...value });
    else if (rest.startsWith('was interrupted before it finished.')) updates.push({ kind: 'interrupted', ...value });
    else if (rest.startsWith('failed: ')) {
      const error = rest.slice('failed: '.length);
      updates.push({ kind: 'failed', ...value, error });
    } else if (rest.startsWith('could not be stopped: ')) {
      const error = rest.slice('could not be stopped: '.length).replace(/\. Check it with delegate_status;.*$/, '');
      updates.push({ kind: 'cancel_failed', ...value, error });
    } else if (rest.startsWith('asks: "')) {
      const request = rest.slice('asks: "'.length).replace(/"(?:\. Answer with delegate_respond[\s\S]*)?$/, '');
      updates.push({ kind: 'request', ...value, request });
    } else {
      const quiet = /^has had no activity for (\d+) min(?:, while running (.*?))?\./.exec(rest);
      if (quiet) updates.push({ kind: 'quiet', ...value, minutes: Number(quiet[1]), ...(quiet[2] ? { tool: quiet[2] } : {}) });
      else updates.push({ kind: 'text', text: bullet });
    }
  }
  return updates;
}

/** One update in the user's language. The agent tile is drawn beside it, not inside. */
export function automaticUpdateLabel(update: AutomaticUpdate, copy: Copy): string {
  const quoted = (title: string, en: string, zh: string) => copy(`"${title}" ${en}`, `「${title}」${zh}`);
  switch (update.kind) {
    case 'completed': return quoted(update.title, 'finished', '已完成');
    case 'failed': return copy(`"${update.title}" failed: ${update.error}`, `「${update.title}」失败：${update.error}`);
    case 'interrupted': return quoted(update.title, 'was interrupted', '被中断了');
    case 'cancel_failed': return quoted(update.title, 'could not be stopped', '没能停下');
    case 'request': return copy(`"${update.title}" asks: ${update.request}`, `「${update.title}」在问：${update.request}`);
    case 'quiet': return copy(`"${update.title}" has been quiet for ${update.minutes} min`, `「${update.title}」${update.minutes} 分钟没有动静`);
    default: return update.text;
  }
}

/** Collapsed row: the first update as the summary plus how many more the message carries. */
export function automaticSummary(text: string, copy: Copy): { first: string; more: number; updates: AutomaticUpdate[] } {
  const updates = automaticUpdates(text);
  if (!updates.length) return { first: copy('Delegate update', '子任务有更新'), more: 0, updates };
  return { first: automaticUpdateLabel(updates[0]!, copy), more: Math.max(0, updates.length - 1), updates };
}
