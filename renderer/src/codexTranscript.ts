import type { ChatItem } from '@threadterm/protocol';

export interface CodexTurn {
  id: string;
  items: ChatItem[];
  activity: ChatItem[];
  response: ChatItem[];
  elapsedMs?: number;
  completed: boolean;
  settled: boolean;
  turnStatus?: ChatItem['turnStatus'];
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
      groups.push({ id: item.id, items: [item], activity: [], response: [], completed: false, settled: false });
    }
  }
  for (const group of groups) {
    group.elapsedMs = [...group.items].reverse().find(item => item.elapsedMs != null)?.elapsedMs;
    const status = [...group.items].reverse().find(item => item.turnStatus)?.turnStatus;
    group.turnStatus = status;
    group.completed = status ? status === 'completed' : group.elapsedMs != null;
    group.settled = status ? ['completed','failed','interrupted'].includes(status) : group.elapsedMs != null;
    if (!group.settled || group.items.some(item => item.role === 'user' || item.role === 'system')) {
      group.response = group.items;
      continue;
    }
    // Hide only explicitly classified commentary when phase is available:
    // unphased text may be part of an answer and must remain visible. Older
    // records retain Codex's last-assistant fallback; other providers keep all text.
    const final = [...group.items].reverse().find(item => item.role === 'assistant' && item.parts.some(part => part.type === 'text' && part.text));
    const hasPhase = group.items.some(item => item.parts.some(part => part.type === 'text' && part.phase));
    const isResponseText = (item: ChatItem, part: ChatItem['parts'][number]) => part.type === 'text' && (!collapseCommentary || (hasPhase ? part.phase !== 'commentary' : item === final));
    const responseStart = group.items.findIndex(item => item.parts.some(part => part.text && isResponseText(item, part)));
    for (const [index, item] of group.items.entries()) {
      // ACP and other providers may split the final answer across records and
      // do not expose Codex's commentary convention. Keep all their text.
      // Cards announced inside the response stay there at completion. Earlier
      // cards retain the activity presentation (including Codex commentary).
      const responseCard = responseStart >= 0 && index >= responseStart;
      const visible = item.parts.filter(part => part.type === 'error' || part.type === 'approval' || part.type === 'status' || part.status === 'failed' || part.status === 'declined' || (responseCard && part.type === 'subagent') || isResponseText(item, part));
      const activity = item.parts.filter(part => part.type !== 'usage' && !visible.includes(part));
      if (activity.length) group.activity.push({ ...item, parts: activity });
      if (visible.length) group.response.push({ ...item, parts: visible });
    }
  }
  return groups;
}
