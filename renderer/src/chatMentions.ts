import type { ChatItem, ChatSkill, GitCommitInfo, ProviderCapability, Session } from '@threadterm/protocol';
import type { ContextItem, SessionContextItem } from './chatContext';

export type MentionGroupId = 'files' | 'sessions' | 'commits' | 'agents' | 'skills';
export const MENTION_GROUP_ORDER: readonly MentionGroupId[] = ['files', 'sessions', 'commits', 'agents', 'skills'];
/** Each group shows up to this many rows; the rest need a narrower query. */
export const MENTION_GROUP_LIMIT = 8;
export const MAX_SESSION_SUMMARY_BYTES = 16 * 1024;

export type MentionItem = { id: string; group: MentionGroupId; label: string; detail?: string; item: ContextItem };
export type MentionGroup = { id: MentionGroupId; items: MentionItem[]; total: number };
export type MentionRange = { query: string; start: number; end: number };
export type MentionSources = Partial<Record<MentionGroupId, MentionItem[]>>;

function fileName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) || path; }
function providerId(value: string) { return /^[A-Za-z0-9._-]{1,64}$/.test(value); }

/**
 * The `@` trigger under the caret. It must be at a word start (or after
 * whitespace) and its query may not contain whitespace, so an email address
 * never opens the popup.
 */
export function mentionQuery(text: string, caret: number): MentionRange | undefined {
  if (typeof text !== 'string' || caret < 0 || caret > text.length) return undefined;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return undefined;
  if (at > 0 && !/\s/.test(text[at - 1]!)) return undefined;
  const query = before.slice(at + 1);
  if (/[\s\n\r]/.test(query)) return undefined;
  return { query, start: at, end: caret };
}

/** Files and the unique folders that contain them. */
export function fileMentionItems(paths: readonly string[]): MentionItem[] {
  const items: MentionItem[] = [];
  const seen = new Set<string>();
  const push = (path: string, label: string, detail: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    items.push({ id: `file:${path}`, group: 'files', label, detail, item: { kind: 'file', id: `file:${path}`, path } });
  };
  const dirs = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || !path || /[\r\n]/.test(path) || path.length > 4096) continue;
    push(path, fileName(path), path);
    const slash = path.lastIndexOf('/');
    if (slash > 0) dirs.add(path.slice(0, slash));
  }
  for (const dir of dirs) push(`${dir}/`, `${fileName(dir)}/`, `${dir}/`);
  return items;
}

/**
 * Other chat-capable sessions, same project first, most recently updated first.
 * Terminal sessions cannot serve a transcript, so they are not mentionable.
 */
export function sessionMentionItems(sessions: readonly Session[], currentId: string, currentProjectId?: string): MentionItem[] {
  return sessions
    .filter(session => session.mode === 'chat' && session.id !== currentId && typeof session.title === 'string' && session.title.length <= 4096 && !/[\r\n]/.test(session.title))
    .slice()
    .sort((left, right) => {
      const leftProject = left.projectId !== undefined && left.projectId === currentProjectId ? 0 : 1;
      const rightProject = right.projectId !== undefined && right.projectId === currentProjectId ? 0 : 1;
      if (leftProject !== rightProject) return leftProject - rightProject;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .map(session => ({
      id: `session:${session.id}`,
      group: 'sessions' as const,
      label: session.title || session.id,
      detail: session.provider,
      item: { kind: 'session' as const, id: `session:${session.id}`, sessionId: session.id, title: session.title || session.id, provider: session.provider },
    }));
}

export function commitMentionItems(commits: readonly GitCommitInfo[]): MentionItem[] {
  return commits
    .filter(commit => /^[a-f0-9]{7,64}$/i.test(commit.hash) && commit.subject.trim().length > 0 && !/[\r\n]/.test(commit.subject))
    .map(commit => ({
      id: `commit:${commit.hash}`,
      group: 'commits' as const,
      label: `${commit.hash.slice(0, 7)} ${commit.subject}`,
      detail: commit.authorName,
      item: { kind: 'commit' as const, id: `commit:${commit.hash}`, sha: commit.hash, subject: commit.subject },
    }));
}

/** Chat-capable, installed providers other than the current one. */
export function agentMentionItems(capabilities: readonly ProviderCapability[], currentProvider: string): MentionItem[] {
  return capabilities
    .filter(capability => capability.chat && capability.installed && capability.id !== currentProvider && providerId(capability.id))
    .map(capability => ({
      id: `agent:${capability.id}`,
      group: 'agents' as const,
      label: capability.name || capability.id,
      detail: capability.id,
      item: { kind: 'agent' as const, id: `agent:${capability.id}`, provider: capability.id },
    }));
}

/** Provider skills, carried with the provider's own text invocation. */
export function skillMentionItems(skills: readonly ChatSkill[]): MentionItem[] {
  return skills.flatMap(skill => {
    const name = skill.name.replace(/^\//, '');
    const invocation = skill.invocation.trim();
    if (!name || /[\s\r\n]/.test(name) || name.length > 128 || !invocation || /[\r\n]/.test(invocation) || invocation.length > 256) return [];
    return [{
      id: `skill:${name}`,
      group: 'skills' as const,
      label: name,
      detail: skill.description,
      item: { kind: 'skill' as const, id: `skill:${name}`, name, invocation },
    }];
  });
}

/** Case-insensitive substring filter; prefix matches sort first, then source order. */
export function filterMentionItems(items: readonly MentionItem[], query: string): MentionItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  const matches: { item: MentionItem; index: number; rank: number; position: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const detail = (item.detail ?? '').toLowerCase();
    const labelIndex = label.indexOf(needle);
    const detailIndex = detail.indexOf(needle);
    if (labelIndex < 0 && detailIndex < 0) return;
    const rank = labelIndex === 0 ? 0 : labelIndex > 0 ? 1 : 2;
    const position = labelIndex >= 0 ? labelIndex : detailIndex;
    matches.push({ item, index, rank, position });
  });
  matches.sort((left, right) => left.rank - right.rank || left.position - right.position || left.index - right.index);
  return matches.map(match => match.item);
}

/** Filters each source and caps it; empty groups are dropped. */
export function mentionGroups(sources: MentionSources, query: string, limit = MENTION_GROUP_LIMIT): MentionGroup[] {
  const groups: MentionGroup[] = [];
  for (const id of MENTION_GROUP_ORDER) {
    const items = sources[id];
    if (!items?.length) continue;
    const filtered = filterMentionItems(items, query);
    if (!filtered.length) continue;
    groups.push({ id, items: filtered.slice(0, limit), total: filtered.length });
  }
  return groups;
}

/** The keyboard order of rows across all shown groups. */
export function flatMentionItems(groups: readonly MentionGroup[]): MentionItem[] {
  return groups.flatMap(group => group.items);
}

export type MentionKeyAction = 'next' | 'previous' | 'pick' | 'close' | undefined;

/**
 * What an open popup does with a key. A composing IME owns every key, and an
 * empty popup owns none, so Enter always submits when there is nothing to pick.
 */
export function mentionKeyAction(key: string, options: { count: number; composing?: boolean; shiftKey?: boolean }): MentionKeyAction {
  if (options.composing) return undefined;
  if (key === 'Escape') return 'close';
  if (options.count <= 0) return undefined;
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'previous';
  if (key === 'Tab' || (key === 'Enter' && !options.shiftKey)) return 'pick';
  return undefined;
}

/**
 * The popup's mention-load state machine. `generation` is monotonic for the
 * component lifetime, so a response that resolves after the popup closed,
 * reopened, or switched project/worktree is dropped instead of overwriting
 * fresh data. No timers: state only moves when the popup opens or its scope
 * changes.
 */
export type MentionLoadTicket = { generation: number; key: string };
export type MentionLoadState = { generation: number; open: boolean; key?: string; ticket?: MentionLoadTicket };
export const initialMentionLoadState: MentionLoadState = { generation: 0, open: false };

/** The project/worktree identity that scopes file and commit mention sources. */
export function mentionLoadKey(projectId?: string, worktreePath?: string): string | undefined { return projectId ? `${projectId}\u0000${worktreePath ?? ''}` : undefined; }

/**
 * Advances the load state for one closed/open or scope change. Returns the same
 * state while one open stays on the same scope, and a fresh ticket (new
 * generation) whenever the popup transitions from closed to open, or the
 * project/worktree changes while it stays open.
 */
export function beginMentionLoad(state: MentionLoadState, open: boolean, key: string | undefined): MentionLoadState {
  if (state.open && open && state.ticket && state.ticket.key === key) return state;
  if (!open || !key) return { ...state, open, ticket: undefined };
  const generation = state.generation + 1;
  return { generation, open: true, key, ticket: { generation, key } };
}

/** Whether a resolved response still belongs to the active load ticket. */
export function mentionLoadCurrent(ticket: MentionLoadTicket | undefined, state: MentionLoadState): boolean {
  return Boolean(ticket && state.ticket && ticket.generation === state.ticket.generation && ticket.key === state.ticket.key);
}

/**
 * A bounded plain-text reading of a referenced session for when the session-info
 * tool is off: the last user and assistant texts, newest retained first, capped
 * at 16 KiB on a UTF-8 character boundary.
 */
export function sessionSummary(items: readonly ChatItem[], limit = MAX_SESSION_SUMMARY_BYTES): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  for (const item of items) {
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    for (const part of item.parts) {
      if (part.type !== 'text' || !part.text?.trim()) continue;
      lines.push(`${item.role === 'user' ? 'User' : 'Assistant'}: ${part.text.trim()}`);
    }
  }
  let text = lines.join('\n\n');
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= limit) return text;
  const start = encoded.byteLength - limit;
  for (let offset = 0; offset < 4; offset++) {
    try { return decoder.decode(encoded.slice(start + offset)); }
    catch { /* Move to a UTF-8 boundary. */ }
  }
  return text.slice(-limit);
}

export function sessionContextItem(item: SessionContextItem, items: readonly ChatItem[], sessionInfoEnabled: boolean): SessionContextItem {
  if (sessionInfoEnabled) return item;
  const summary = sessionSummary(items);
  return summary ? { ...item, summary } : item;
}

/** The lifecycle and session an async session-mention read belongs to. */
export type MentionAttachTarget = { sessionId?: string; lifecycle: unknown };

/**
 * Whether a resolved session-mention read still belongs to the session (and
 * component lifecycle) that started it. A session switch replaces the
 * lifecycle object, so a late `chat.read` must not attach its chip to the new
 * session's tray.
 */
export function mentionAttachIsCurrent(captured: MentionAttachTarget, current: MentionAttachTarget): boolean {
  return captured.sessionId === current.sessionId && captured.lifecycle === current.lifecycle;
}
