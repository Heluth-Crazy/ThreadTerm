import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Group, GroupDelivery, GroupMember, GroupMessage, ProviderCapability, Session } from '@threadterm/protocol';
import { operationId, request, subscribeEvents } from '../bridge';
import { useTranslation } from '../i18n';
import { liveGroupDeliveries, mergeGroupMessages, type GroupReferenceInput } from '../groupComposer';
import { readLoadedGroupWindow } from '../groupHistory';
import { groupIssueText, groupIssueTitle, type GroupIssue } from '../groupMessages';
import { Icon } from './PrototypeIcon';
import { GroupComposer, type GroupComposeIntent } from './GroupComposer';
import { GroupMemberEditor } from './GroupMemberEditor';
import { GroupHeader } from './GroupHeader';
import { GroupMemberStrip } from './GroupMemberStrip';
import { DeliveryRow, ReplyCard, SystemMessage, UserMessage } from './GroupTimelineItems';
import './group-chat.css';

type Props = { id: string; providers: ProviderCapability[]; sessions: Session[]; visible?: boolean; onOpenSession: (id: string) => void; onOpenFile: (path: string) => void; onOpenUrl: (url: string) => void; onChanged: () => void; onTitleChanged?: (id: string, title: string) => void };
type Copy = (en: string, zh: string) => string;
export function GroupChatView(props: Props) { return <GroupRoom key={props.id} {...props} />; }
function GroupRoom({ id, providers, sessions, visible = true, onOpenSession, onOpenFile, onOpenUrl, onChanged, onTitleChanged }: Props) {
 const zh = useTranslation().locale === 'zh-CN', copy: Copy = (en, cn) => zh ? cn : en;
 const [group, setGroup] = useState<Group>(), [issue, setIssue] = useState<GroupIssue>(), [busy, setBusy] = useState(false), [connected, setConnected] = useState(true), [paging, setPaging] = useState(false), [now, setNow] = useState(Date.now());
 const [editor, setEditor] = useState<{ member?: GroupMember; handle?: string }>(), [intent, setIntent] = useState<GroupComposeIntent>(), [referenceMessages, setReferenceMessages] = useState<GroupMessage[]>([]);
 const current = useRef(group), mounted = useRef(false), operationBusy = useRef(false), cursor = useRef<{ before?: string; hasMore?: boolean } | undefined>(undefined), board = useRef<HTMLDivElement>(null), follow = useRef(true), prepend = useRef<{ top: number; height: number } | undefined>(undefined), refreshRef = useRef<() => Promise<void>>(async () => {}), pageBusy = useRef(false);
 current.current = group;
 useEffect(() => {
  if (group) onTitleChanged?.(id, group.title);
 }, [id, group?.title, onTitleChanged]);
 const apply = (next: Group, older = false) => {
  if (!mounted.current) return;
  if (older || !cursor.current) cursor.current = { before: next.before, hasMore: next.hasMore };
  setGroup(old => {
   if (old && next.revision < old.revision && !older) return old;
   const metadata = old && next.revision < old.revision ? old : next;
   const value = { ...metadata, messages: mergeGroupMessages(old?.messages ?? [], next.messages), hasMore: cursor.current?.hasMore, before: cursor.current?.before };
   current.current = value; return value;
  });
 };
 useEffect(() => {
  mounted.current = true;
  if (!visible) return () => { mounted.current = false; };
  setConnected(false);
  let cancelled = false, reading = false, again = false;
  const refresh = async () => {
   if (reading) { again = true; return; }
   reading = true;
   try { do {
    again = false;
    const oldest = current.current?.messages[0]?.id;
    const next = await readLoadedGroupWindow(async params => { if (cancelled) throw new Error('group_view_hidden'); return request('group.read', { id, ...params }); }, oldest);
    if (cancelled) return;
    apply(next); setConnected(true); setNow(Date.now());
   } while (again && !cancelled); }
   catch (error) { if (!cancelled) setIssue(error instanceof Error ? { code: error.message } : { en: 'Could not load this group.', zh: '无法加载此群聊。' }); }
   finally { reading = false; }
  };
  refreshRef.current = refresh;
  const unsubscribe = subscribeEvents(event => {
   const data = event.data as { kind?: string; id?: string; state?: string } | null;
   if (event.event === 'state.changed' && data?.kind === 'group' && data.id === id) void refresh();
   if (event.event === 'runtime.transport') { if (data?.state === 'reconnected') void refresh(); else if (['disconnected', 'incompatible'].includes(data?.state ?? '')) setConnected(false); }
  });
  void refresh(); return () => { cancelled = true; mounted.current = false; unsubscribe(); };
 }, [id, visible]);
 const messages = group?.messages ?? [], live = useMemo(() => liveGroupDeliveries(messages), [messages]);
 const working = visible && live.some(({ delivery }) => delivery.state === 'working');
 // This visible-work-only clock updates elapsed text; it never requests room state.
 useEffect(() => {
  if (!working) return;
  let timer = 0;
  const stop = () => { if (timer) { window.clearInterval(timer); timer = 0; } };
  const changed = () => { stop(); if (document.visibilityState !== 'hidden') { setNow(Date.now()); timer = window.setInterval(() => setNow(Date.now()), 1000); } };
  changed(); document.addEventListener('visibilitychange', changed); return () => { stop(); document.removeEventListener('visibilitychange', changed); };
 }, [working]);
 useLayoutEffect(() => { const node = board.current; if (!node) return; if (prepend.current) { node.scrollTop = prepend.current.top + node.scrollHeight - prepend.current.height; prepend.current = undefined; } else if (follow.current) node.scrollTop = node.scrollHeight; }, [messages.length, visible]);
 const loadOlder = async () => {
  if (pageBusy.current || !cursor.current?.hasMore || !cursor.current.before) return;
  pageBusy.current = true; setPaging(true);
  try { const next = await request('group.read', { id, before: cursor.current.before }); const element = board.current; if (element) prepend.current = { top: element.scrollTop, height: element.scrollHeight }; apply(next, true); } catch (error) { prepend.current = undefined; setIssue(error instanceof Error ? { code: error.message } : { en: 'Could not load older messages.', zh: '无法加载更早的消息。' }); } finally { pageBusy.current = false; setPaging(false); }
 };
 const run = async (action: () => Promise<Group>) => {
  if (operationBusy.current) return false;
  operationBusy.current = true; setBusy(true); setIssue(undefined);
  try { apply(await action()); onChanged(); return true; }
  catch (error) { const text = error instanceof Error ? error.message : String(error); if (mounted.current) setIssue({ code: text }); void refreshRef.current(); return false; }
  finally { operationBusy.current = false; if (mounted.current) setBusy(false); }
 };
 const send = (text: string, to: string[], references: GroupReferenceInput[]) => run(() => request('group.send', { id, text, to, references, expectedRevision: current.current?.revision, operationId: operationId() }));
 const deliveryAction = (messageId: string, delivery: GroupDelivery, action: 'stop' | 'resend') => run(() => action === 'stop' ? request('group.stop', { id, messageId, handle: delivery.handle, expectedRevision: current.current?.revision, operationId: operationId() }) : request('group.resend', { id, messageId, handle: delivery.handle, expectedRevision: current.current?.revision, operationId: operationId() }));
 const findReply = async (handle: string, messageId?: string) => {
  const sessionId = current.current?.members.find(member => member.handle === handle)?.sessionId;
  const matchesReply = (message: GroupMessage) => messageId ? message.id === messageId : message.author === 'member' && (message.sessionId ? message.sessionId === sessionId : message.handle === handle);
  let before = current.current?.before, more = current.current?.hasMore;
  setBusy(true);
  try {
   let candidate = [...(current.current?.messages ?? [])].reverse().find(matchesReply);
   while (candidate || more && before) {
    const page = candidate ? { ...current.current!, messages: current.current!.messages } : await request('group.read', { id, before });
    if (!mounted.current) return;
    const reply = candidate ?? [...page.messages].reverse().find(matchesReply);
    candidate = undefined;
    if (reply) {
     let topic = current.current?.messages.find(message => message.id === reply.replyTo) ?? page.messages.find(message => message.id === reply.replyTo), parentPage = page;
     while (!topic && reply.replyTo && parentPage.hasMore && parentPage.before) {
      parentPage = await request('group.read', { id, before: parentPage.before });
      if (!mounted.current) return;
      topic = parentPage.messages.find(message => message.id === reply.replyTo);
     }
     if (reply.replyTo && !topic) { setIssue({ en: 'The reply’s original message is unavailable. Load its history before referencing it.', zh: '此回复的原始消息不可用，请先加载相关历史再引用。' }); return; }
     setReferenceMessages(old => mergeGroupMessages(old, topic ? [topic, reply] : [reply])); return;
    }
    before = page.before; more = page.hasMore;
   }
   setIssue({ en: `@${handle} has not posted a reply.`, zh: `@${handle} 尚未发布回复。` });
  } catch (error) { setIssue(error instanceof Error ? { code: error.message } : { en: 'Could not find the reply.', zh: '无法查找回复。' }); } finally { if (mounted.current) setBusy(false); }
 };
 if (!group) return <div className="group-chat gc-loading" data-testid="group-view" role="status">{issue ? groupIssueText(issue, zh) : copy('Loading group chat…', '正在加载群聊…')}{issue && <button className="btn" onClick={() => void refreshRef.current()}>{copy('Retry', '重试')}</button>}</div>;
 const disabled = busy || !connected, composeGroup = { ...group, messages: mergeGroupMessages(referenceMessages, messages) };
 const editMember = editor?.member;
 const newestReply = [...messages].reverse().find(message => message.author === 'member')?.id;
 return (
  <section className="group-chat" data-testid="group-view" data-group-id={group.id}
   data-archived={group.archived} aria-label={copy('Group chat', '群聊')}>
   <GroupHeader group={group} disabled={disabled} copy={copy} onAdd={() => setEditor({})}
    onRename={title => run(() => request('group.rename', {
     id, title, expectedRevision: current.current?.revision, operationId: operationId(),
    }))}
    onArchive={() => run(() => request('group.archive', {
     id, archived: !group.archived, expectedRevision: current.current?.revision, operationId: operationId(),
    }))} />
   <GroupMemberStrip group={group} sessions={sessions} now={now} zh={zh} copy={copy}
    disabled={disabled} onOpen={onOpenSession} onEdit={member => setEditor({ member })} />
   {group.filesCheck?.state === 'off' && group.members.some(member => member.mode === 'read_only') && (
    <div className="gc-notice gc-files-check" title={group.filesCheck.detail} role="status">
     <Icon name="info" />
     <span>{group.filesCheck.reason === 'no_git'
      ? copy('Git not found — install Git to check read-only members’ file changes.', '未找到 Git — 安装 Git 后可检查只读成员的文件变更。')
      : group.filesCheck.reason === 'not_a_repository'
       ? copy('Not a Git repository — read-only file checks are off.', '此文件夹不是 Git 仓库 — 只读文件检查已关闭。')
       : copy('Read-only file checks are unavailable for this folder.', '此文件夹无法进行只读文件检查。')}</span>
    </div>
   )}
   {issue && (
    <div className="gc-notice gc-error" role="alert" title={groupIssueTitle(issue)}>
     <Icon name="info" /><span>{groupIssueText(issue, zh)}</span>
     <button className="icon-btn icon-btn-sm" aria-label={copy('Dismiss', '关闭')} title={copy('Dismiss', '关闭')}
      onClick={() => setIssue(undefined)}><Icon name="close" /></button>
    </div>
   )}
   <div className="gc-timeline" data-testid="group-timeline" ref={board} onScroll={event => {
    const node = event.currentTarget;
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    if (node.scrollTop < 32 && !paging) void loadOlder();
   }}>
    {group.hasMore && (
     <button className="btn btn-sm gc-load-older" disabled={paging} onClick={() => void loadOlder()}>
      {paging ? copy('Loading older messages…', '正在加载更早的消息…') : copy('Load older messages', '加载更早的消息')}
     </button>
    )}
    {!messages.length && (
     <div className="gc-empty">
      <Icon name="agents" /><h3>{copy('A shared workspace. Private agent context.', '共享工作空间，各智能体保留独立上下文。')}</h3>
      <p>{copy('Address @All to work independently, or choose one member. Only the references you include are shared.',
       '使用 @All 让成员独立处理，或指定一位成员。只有你附加的引用会被共享。')}</p>
     </div>
    )}
    {messages.map(message => {
     const props = {
      group, message, sessions, zh, copy, onOpenSession, onOpenFile, onOpenUrl,
      onIntent: setIntent, onError: setIssue,
     };
     const Item = message.author === 'user' ? UserMessage : message.author === 'member' ? ReplyCard : SystemMessage;
     return (
      <div className="gc-timeline-item" key={message.id}>
       <Item {...props} newest={message.id === newestReply} />
       {live.filter(row => row.messageId === message.id).map(({ delivery }) => (
        <DeliveryRow key={delivery.sessionId} group={group} messageId={message.id} delivery={delivery}
         sessions={sessions} now={now} zh={zh} copy={copy} disabled={disabled} onOpenSession={onOpenSession}
         onAction={(messageId, row, action) => { void deliveryAction(messageId, row, action); }} />
       ))}
      </div>
     );
    })}
   </div>
   <GroupComposer group={composeGroup} zh={zh} disabled={disabled} intent={intent} onSend={send}
    onAddMember={handle => setEditor({ handle })} onFindReply={findReply} />
   {editor && (
    <GroupMemberEditor group={group} providers={providers} member={editMember} initialHandle={editor.handle}
     zh={zh} busy={busy} onClose={() => setEditor(undefined)}
     onSave={async value => {
      const ok = await run(() => editMember
       ? request('group.member.update', {
        id, sessionId: editMember.sessionId, handle: value.handle, mode: value.mode,
        expectedRevision: current.current?.revision, operationId: operationId(),
       })
       : request('group.member.add', {
        id, ...value, expectedRevision: current.current?.revision, operationId: operationId(),
       }));
      if (ok) setEditor(undefined);
     }}
     onRemove={async () => {
      if (editMember && await run(() => request('group.member.remove', {
       id, sessionId: editMember.sessionId, expectedRevision: current.current?.revision, operationId: operationId(),
      }))) setEditor(undefined);
     }} />
   )}
  </section>
 );
}
