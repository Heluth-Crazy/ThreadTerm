import type { ChatItem } from '@threadterm/protocol';

export interface CodexTurn {
  id: string;
  items: ChatItem[];
  activity: ChatItem[];
  response: ChatItem[];
  elapsedMs?: number;
}

// Native Codex items are separate records. A duration can arrive on an empty
// completion record, so assemble the turn before choosing its disclosure body.
export function groupCodexTranscript(items: ChatItem[], collapseCommentary = true): CodexTurn[] {
  const groups: CodexTurn[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const standalone = item.role === 'user' || item.role === 'system' || item.parts.some(part => part.type === 'status');
    if (!standalone && item.turnId && previous?.items[0]?.turnId === item.turnId
      && previous.items[0]!.role !== 'user' && previous.items[0]!.role !== 'system' && !previous.items[0]!.parts.some(part => part.type === 'status')) {
      previous.items.push(item);
    } else {
      groups.push({ id: item.id, items: [item], activity: [], response: [] });
    }
  }
  for (const group of groups) {
    group.elapsedMs = [...group.items].reverse().find(item => item.elapsedMs != null)?.elapsedMs;
    if (group.elapsedMs == null || group.items.some(item => item.role === 'user' || item.role === 'system')) {
      group.response = group.items;
      continue;
    }
    // The projection does not retain native message phase. For completed turns,
    // the last assistant text is the final reply; keep alerts and approvals visible.
    const final = [...group.items].reverse().find(item => item.role === 'assistant' && item.parts.some(part => part.type === 'text' && part.text));
    for (const item of group.items) {
      // ACP and other providers may split the final answer across records and
      // do not expose Codex's commentary convention. Keep all their text.
      const visible = item.parts.filter(part => part.type === 'error' || part.type === 'approval' || part.type === 'status' || part.status === 'failed' || part.status === 'declined' || ((!collapseCommentary || item === final) && part.type === 'text'));
      const activity = item.parts.filter(part => part.type !== 'usage' && !visible.includes(part));
      if (activity.length) group.activity.push({ ...item, parts: activity });
      if (visible.length) group.response.push({ ...item, parts: visible });
    }
  }
  return groups;
}
