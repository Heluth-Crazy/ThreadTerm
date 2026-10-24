import { parseGroupMentions, type Group, type GroupDelivery, type GroupMember, type GroupMessage, type GroupReference, type Session } from '@threadterm/protocol';

export type GroupReferenceInput = Pick<GroupReference, 'kind' | 'messageId' | 'path' | 'url'>;
export type ComposerReference = GroupReferenceInput & { title: string; bytes: number; shortened: boolean; missing?: boolean };
const encoder = new TextEncoder();
export const referenceKey = (ref: GroupReferenceInput) => `${ref.kind}:${ref.messageId ?? ref.path ?? ref.url ?? ''}`;
export const byteSize = (text: string) => encoder.encode(text).length;
export const byteLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
/** The compact visible label for a reply chip; the full title remains its tooltip. */
export function replyReferenceHandle(ref: Pick<GroupReference, 'kind' | 'handle' | 'title'>): string | undefined {
 if (ref.kind !== 'reply') return undefined;
 return ref.handle ?? /^@([a-z0-9-]{1,24})'s reply\b/i.exec(ref.title)?.[1];
}
/** Collapse historical duplicate suggestions without changing their tooltip evidence. */
export function groupSuggestions(suggestions: readonly { handle: string; text: string }[] | undefined) {
 const result: { handle: string; text: string }[] = [];
 const byHandle = new Map<string, number>();
 for (const suggestion of suggestions ?? []) {
  const index = byHandle.get(suggestion.handle);
  if (index === undefined) { byHandle.set(suggestion.handle, result.length); result.push({ ...suggestion }); continue; }
  const prior = result[index];
  if (!prior.text.split('\n').includes(suggestion.text)) prior.text += `\n${suggestion.text}`;
 }
 return result;
}
/** The leading recipient identity, excluding no-mention fallback recipients. */
export function leadingGroupRecipientKey(text: string, parsed: readonly string[], handles: readonly string[]) {
 const leading = /^\s*@([a-z0-9-]{1,24})\b/i.exec(text)?.[1]?.toLowerCase();
 const explicitlyAddressed = leading === 'all' || !!leading && handles.some(handle => handle === leading);
 return explicitlyAddressed ? parsed.join('\0') : '';
}
/** Picker/intent recipients survive ordinary drafting until the leading recipient changes. */
export function selectedGroupRecipients(text: string, parsed: readonly string[], handles: readonly string[], manual?: { key: string; to: string[] }) {
 const key = leadingGroupRecipientKey(text, parsed, handles);
 return manual?.key === key ? manual.to : [...parsed];
}
function bounded(text: string, max: number): string {
 if (byteSize(text) <= max) return text;
 const note = '\n[shortened — ask the user for the rest]';
 let prefix = '', used = 0;
 for (const character of text) { const bytes = byteSize(character); if (used + bytes > Math.max(0, max - byteSize(note))) break; prefix += character; used += bytes; }
 return prefix + note;
}
export function describeGroupReference(ref: GroupReferenceInput, messages: readonly GroupMessage[]): ComposerReference {
 const message = ref.messageId ? messages.find(message => message.id === ref.messageId) : undefined;
 let title = ref.kind === 'file' ? `File ${ref.path ?? ''}` : ref.kind === 'url' ? 'URL' : 'Earlier message';
 if (ref.kind === 'reply') {
  const topic = messages.find(row => row.id === message?.replyTo)?.body ?? '';
  title = `@${message?.handle ?? 'member'}'s reply (to: "${[...topic].slice(0, 80).join('')}")`;
 }
 const content = ref.kind === 'file' ? ref.path ?? '' : ref.kind === 'url' ? ref.url ?? '' : `${message?.body ?? ''}${message?.outputs ? '\nOutputs: ' + JSON.stringify(message.outputs) : ''}`;
 const label = `\n\n## Referenced: ${title}\n`, block = label + content, shortened = byteSize(block) > 8192;
 let copied = bounded(block, 8192);
 if (ref.kind === 'reply' && shortened && message?.outputs) {
  const outputs = bounded(' ' + JSON.stringify(message.outputs), 4096);
  copied = label + bounded(message.body, Math.max(0, 8192 - byteSize(label + '\nOutputs:' + outputs))) + '\nOutputs:' + outputs;
 }
 return { ...ref, title, bytes: byteSize(copied), shortened, missing: (ref.kind === 'reply' || ref.kind === 'message') && (!message || ref.kind === 'reply' && !!message.replyTo && !messages.some(row => row.id === message.replyTo)) };
}
export function groupComposition(text: string, group: Pick<Group, 'members' | 'lastRecipients' | 'messages'>) {
 const parsed = parseGroupMentions(text, group.members.map(member => member.handle), group.lastRecipients);
 const references: ComposerReference[] = [], unresolved: string[] = [];
 for (const handle of parsed.referenceHandles) {
  const sessionId = group.members.find(member => member.handle === handle)?.sessionId;
  const reply = [...group.messages].reverse().find(message => message.author === 'member' && (message.sessionId ? message.sessionId === sessionId : message.handle === handle));
  if (reply && (!reply.replyTo || group.messages.some(message => message.id === reply.replyTo))) references.push(describeGroupReference({ kind: 'reply', messageId: reply.id }, group.messages));
  else unresolved.push(handle);
 }
 return { ...parsed, references, unresolved };
}
export function mentionCompletion(text: string, caret: number, composing = false) {
 if (composing) return undefined;
 const before = text.slice(0, caret), match = /(?:^|\s)@([a-z0-9-]*)$/i.exec(before);
 return match ? { query: match[1].toLowerCase(), start: caret - match[1].length - 1, end: caret } : undefined;
}
export function insertGroupMention(text: string, completion: NonNullable<ReturnType<typeof mentionCompletion>>, handle: string) {
 const inserted = `@${handle} `;
 return { text: text.slice(0, completion.start) + inserted + text.slice(completion.end), caret: completion.start + inserted.length };
}
export function groupEnterSends(event: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }, composing: boolean) {
 return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing;
}
export function mergeGroupMessages(old: readonly GroupMessage[], incoming: readonly GroupMessage[]): GroupMessage[] {
 const messages = new Map(old.map(message => [message.id, message]));
 for (const message of incoming) messages.set(message.id, message);
 return [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
export function groupMemberStatus(member: GroupMember, session: Session | undefined, messages: readonly GroupMessage[]) {
 const deliveries = messages.flatMap(message => message.deliveries ?? []).filter(delivery => delivery.sessionId === member.sessionId);
 const activity = session?.activity?.state;
 const unreadReply = activity === 'awaiting_input' && session?.status !== 'waiting';
 if (activity === 'awaiting_approval' || activity === 'awaiting_parent' || activity === 'awaiting_input' && !unreadReply || member.state === 'needs_user' && !unreadReply || deliveries.some(delivery => delivery.state === 'needs_user')) return 'needs_user' as const;
 if (activity === 'running' || member.state === 'working' || deliveries.some(delivery => delivery.state === 'working')) return 'working' as const;
 if (member.state === 'queued' || deliveries.some(delivery => delivery.state === 'queued')) return 'queued' as const;
 if (member.state === 'failed') return 'failed' as const;
 const latest = deliveries.at(-1)?.state;
 return latest === 'replied' || latest === 'stopped' || latest === 'failed' ? latest : 'idle' as const;
}
export const liveGroupDeliveries = (messages: readonly GroupMessage[]) => messages.flatMap(message => (message.deliveries ?? []).filter(delivery => ['queued', 'working', 'needs_user', 'failed', 'stopped'].includes(delivery.state)).map(delivery => ({ messageId: message.id, delivery })));
export function deliveryElapsed(delivery: GroupDelivery, now: number) {
 if (!delivery.startedAt) return undefined;
 const start = Date.parse(delivery.startedAt), end = delivery.finishedAt ? Date.parse(delivery.finishedAt) : now;
 return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}
export function droppedGroupReferences(text: string, cwd: string): GroupReferenceInput[] {
 const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
 const result: GroupReferenceInput[] = [], root = normalize(cwd).replace(/\/$/, '');
 for (const raw of text.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'))) {
  if (/^https?:\/\//i.test(raw)) { try { const url = new URL(raw); if (url.hostname) result.push({ kind: 'url', url: url.href }); } catch { /* Invalid drops remain unattached. */ } continue; }
  let path = raw;
  if (/^file:\/\//i.test(path)) { try { const url = new URL(path); if (url.host && url.host !== 'localhost') continue; path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1'); } catch { continue; } }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) continue;
  path = normalize(path);
  const windows = /^[a-z]:\//i.test(root) || root.startsWith('//');
  if ((windows ? path.toLowerCase() : path).startsWith((windows ? root.toLowerCase() : root) + '/')) path = path.slice(root.length + 1);
  if (path && !path.startsWith('/') && !/^[a-z]:/i.test(path) && !path.split('/').some(part => part === '..') && !path.includes('\0')) result.push({ kind: 'file', path });
 }
 return [...new Map(result.map(ref => [referenceKey(ref), ref])).values()];
}
