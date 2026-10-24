import { useLayoutEffect, useRef, useState } from 'react';
import type { Group, GroupDelivery, GroupMessage, Session } from '@threadterm/protocol';
import { byteLabel, deliveryElapsed, groupSuggestions, replyReferenceHandle } from '../groupComposer';
import { formatChatDuration } from '../chatPresentation';
import { AgentIcon, Icon } from './PrototypeIcon';
import { GroupMarkdown } from './GroupMarkdown';
import { ReplyOutputs } from './GroupReplyOutputs';
import { groupActivity } from './GroupMemberStrip';
import { GroupStatus, groupStateText, groupStatusClass, type GroupCopy } from './GroupStatus';
import type { GroupComposeIntent } from './GroupComposer';
import { groupMenuBlur, groupMenuKeys } from './groupMenuKeys';
import { groupIssueText, groupIssueTitle, groupReferenceTitle, groupSystemMessage, type GroupIssue } from '../groupMessages';

type TimelineProps = {
  group: Group;
  message: GroupMessage;
  sessions: Session[];
  zh: boolean;
  copy: GroupCopy;
  newest?: boolean;
  onOpenSession: (id: string) => void;
  onOpenFile: (path: string) => void;
  onOpenUrl: (url: string) => void;
  onIntent: (intent: GroupComposeIntent) => void;
  onError: (error: GroupIssue) => void;
};

function messageTime(createdAt: string, zh: boolean) {
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(zh ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }) : '';
}

function ClampedReply({ message, zh, onOpenFile, onOpenUrl }: Pick<TimelineProps, 'message' | 'zh' | 'onOpenFile' | 'onOpenUrl'>) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => { if (!expanded) setOverflow(node.scrollHeight > node.clientHeight + 1); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [message.body, expanded]);
  return (
    <>
      <div className={`gc-reply-body${expanded ? ' is-expanded' : ''}`} ref={ref}>
        <GroupMarkdown text={message.body} zh={zh} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
      </div>
      {(overflow || expanded) && (
        <button className="btn btn-sm btn-ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {zh ? expanded ? '收起' : '展开' : expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

function MessageActions({ group, message, copy, onOpenSession, onIntent, onError }: TimelineProps) {
  const [handoff, setHandoff] = useState(false);
  return (
    <div className="gc-reply-actions">
      {message.sessionId && (
        <button className="btn btn-sm btn-ghost" onClick={() => onOpenSession(message.sessionId!)}>
          <span className="gc-action-label">{copy('Open chat', '打开对话')}<Icon name="popout" /></span>
        </button>
      )}
      {message.author === 'member' && (
        <div className="gc-menu-anchor" onKeyDown={event => groupMenuKeys(event, handoff, setHandoff)}
          onBlur={event => groupMenuBlur(event, setHandoff)} onClick={event => {
            if ((event.target as Element).closest('[role=option]')) {
              event.currentTarget.querySelector<HTMLButtonElement>('[role=combobox]')?.focus();
            }
          }}>
          <button className="btn btn-sm btn-ghost" role="combobox" aria-label={copy('Hand off to', '交接给')}
            aria-expanded={handoff} aria-haspopup="listbox" disabled={group.archived}
            onClick={() => setHandoff(value => !value)}>
            <span className="gc-action-label">{copy('Hand off to…', '交接给…')}<Icon name="chevD" /></span>
          </button>
          {handoff && (
            <div className="popover gc-handoff-menu" role="listbox" onKeyDown={event => {
              if (event.key === 'Escape') setHandoff(false);
            }}>
              {group.members.map(member => (
                <button className="menu-item" role="option" data-value={member.handle} aria-selected={false} key={member.sessionId}
                  onClick={() => {
                    setHandoff(false);
                    onIntent({ text: `@${member.handle} `, to: [member.handle], reference: { kind: 'reply', messageId: message.id } });
                  }}>@{member.handle}</button>
              ))}
            </div>
          )}
        </div>
      )}
      <button className="btn btn-sm btn-ghost" disabled={group.archived} onClick={() => onIntent({
        text: '', reference: { kind: message.author === 'member' ? 'reply' : 'message', messageId: message.id },
      })}><span className="gc-action-label">{copy('Quote', '引用')}</span></button>
      <button className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard.writeText(message.body)
        .catch(() => onError({ en: 'Could not copy this message.', zh: '无法复制此消息。' }))}>
        <span className="gc-action-label">{copy('Copy', '复制')}</span>
      </button>
    </div>
  );
}

function MessageReferences({ group, message, copy, zh }: Pick<TimelineProps, 'group' | 'message' | 'copy' | 'zh'>) {
  return message.references?.map((reference, index) => (
    <span className="chip flat gc-message-reference" title={groupReferenceTitle(reference, group.messages, zh)} key={index}>
      <Icon name={reference.kind === 'url' ? 'globe' : 'file'} />
      <span>{reference.kind === 'reply' && replyReferenceHandle(reference)
        ? copy(`@${replyReferenceHandle(reference)}'s reply`, `@${replyReferenceHandle(reference)} 的回复`)
        : groupReferenceTitle(reference, group.messages, zh)}</span>
      <span>{copy(` · ${byteLabel(reference.bytes)}`, ` · ${byteLabel(reference.bytes)}`)}{reference.shortened ? copy(' · shortened', ' · 已缩短') : ''}</span>
    </span>
  ));
}

export function UserMessage(props: TimelineProps) {
  const { group, message, copy, zh } = props;
  return (
    <article className="gc-message is-user" data-testid={`group-message-${message.id}`}
      data-message-id={message.id} data-author="user">
      <div className="gc-user-bubble"><p className="gc-user-text">{message.body}</p></div>
      <div className="gc-message-meta">
       <div className="gc-meta-items">
        <time dateTime={message.createdAt} title={message.createdAt}>{messageTime(message.createdAt, zh)}</time>
        {message.deliveries?.map(delivery => (
          <span className={`chip ${groupStatusClass(delivery.state)}`} data-handle={delivery.handle}
            data-state={delivery.state} key={delivery.sessionId}
            title={delivery.error ? groupIssueTitle({ code: delivery.error }) : groupStateText(delivery.state, copy)}
            aria-label={`@${delivery.handle}: ${groupStateText(delivery.state, copy)}`}>
            @{delivery.handle}<span>{groupStateText(delivery.state, copy)}</span>
          </span>
        ))}
        <MessageReferences group={group} message={message} copy={copy} zh={zh} />
       </div>
       <MessageActions {...props} />
      </div>
    </article>
  );
}

export function ReplyCard(props: TimelineProps) {
  const { message, group, sessions, zh, copy, newest, onIntent } = props;
  const member = group.members.find(row => row.sessionId === message.sessionId);
  const provider = member?.provider ?? sessions.find(row => row.id === message.sessionId)?.provider;
  return (
    <article className={`gc-message is-member${newest ? ' is-newest' : ''}`}
      data-testid={`group-message-${message.id}`} data-message-id={message.id} data-author="member">
      <header>
        {provider && <AgentIcon provider={provider} size={16} />}
        <strong title={`@${message.handle}`}>@{message.handle}</strong>
        <GroupStatus state="replied" copy={copy} />
        {newest ? <div className="gc-header-tail">
          <MessageActions {...props} />
          <time dateTime={message.createdAt} title={message.createdAt}>{messageTime(message.createdAt, zh)}</time>
        </div> : <>
          <MessageActions {...props} />
          <time dateTime={message.createdAt} title={message.createdAt}>{messageTime(message.createdAt, zh)}</time>
        </>}
      </header>
      <ClampedReply {...props} />
      {!!message.references?.length && <div className="gc-message-meta"><MessageReferences group={group} message={message} copy={copy} zh={zh} /></div>}
      <ReplyOutputs {...props} />
      {!!message.suggestions?.length && (
        <div className="gc-suggestions">{groupSuggestions(message.suggestions).map((suggestion, index) => (
          <button className="btn btn-sm btn-ghost" key={index} disabled={group.archived} title={suggestion.text}
            onClick={() => onIntent({ text: '', to: [suggestion.handle], reference: { kind: 'reply', messageId: message.id } })}>
            {copy(`Suggested next: @${suggestion.handle}`, `建议下一步：@${suggestion.handle}`)}
          </button>
        ))}</div>
      )}
    </article>
  );
}

export function SystemMessage(props: TimelineProps) {
  const { message, copy, zh } = props;
  return (
    <article className="gc-message is-system gc-notice" data-testid={`group-message-${message.id}`}
      data-message-id={message.id} data-author="system">
      <Icon name="info" /><span><strong>{copy('Group', '群聊')}</strong> {groupSystemMessage(message.body, zh)}</span>
    </article>
  );
}

export function DeliveryRow({ group, messageId, delivery, sessions, now, zh, copy, disabled, onOpenSession, onAction }: {
  group: Group;
  messageId: string;
  delivery: GroupDelivery;
  sessions: Session[];
  now: number;
  zh: boolean;
  copy: GroupCopy;
  disabled: boolean;
  onOpenSession: (id: string) => void;
  onAction: (messageId: string, delivery: GroupDelivery, action: 'stop' | 'resend') => void;
}) {
  const session = sessions.find(row => row.id === delivery.sessionId);
  const member = group.members.find(row => row.sessionId === delivery.sessionId);
  const failed = delivery.state === 'failed' || delivery.state === 'stopped';
  const activity = delivery.error ? groupIssueText({ code: delivery.error }, zh) : (delivery.state === 'working' ? groupActivity(session) : undefined);
  const elapsed = delivery.state === 'working' ? deliveryElapsed(delivery, now) : undefined;
  return (
    <article className="gc-live" data-testid={`group-live-${messageId}-${delivery.handle}`} data-delivery-state={delivery.state}>
      {member && <AgentIcon provider={member.provider} size={16} />}
      <strong title={`@${delivery.handle}`}>@{delivery.handle}</strong>
      <GroupStatus state={delivery.state} copy={copy} />
      <span className="gc-live-activity" title={delivery.error ? groupIssueTitle({ code: delivery.error }) : activity}>{activity}</span>
      {elapsed !== undefined && <time>{formatChatDuration(elapsed, zh)}</time>}
      <div className="gc-delivery-actions">
        <button className="btn btn-sm btn-ghost" onClick={() => onOpenSession(delivery.sessionId)}>
          {delivery.state === 'needs_user' ? copy('Respond in Chat', '在对话中处理') : copy('Open chat', '打开对话')}
        </button>
        {(failed || delivery.state === 'working' || delivery.state === 'queued') && (
          <button className="btn btn-sm btn-ghost" disabled={disabled || group.archived && failed}
            onClick={() => onAction(messageId, delivery, failed ? 'resend' : 'stop')}>
            {failed ? copy('Resend', '重新发送') : copy('Stop', '停止')}
          </button>
        )}
      </div>
    </article>
  );
}
