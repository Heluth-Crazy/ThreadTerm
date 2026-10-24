import type { Group, GroupMember, Session } from '@threadterm/protocol';
import { groupMemberStatus, liveGroupDeliveries, deliveryElapsed } from '../groupComposer';
import { formatChatDuration } from '../chatPresentation';
import { AgentIcon, Icon } from './PrototypeIcon';
import { GroupStatus, type GroupCopy } from './GroupStatus';
import { groupIssueText, groupIssueTitle, groupReadOnlyNote } from '../groupMessages';

export function groupActivity(session?: Session): string | undefined {
  const reason = session?.activity?.reason;
  return reason && !/^[a-z_]+$/.test(reason) ? reason : undefined;
}

export function GroupMemberStrip({ group, sessions, now, zh, copy, disabled, onOpen, onEdit }: {
  group: Group;
  sessions: Session[];
  now: number;
  zh: boolean;
  copy: GroupCopy;
  disabled: boolean;
  onOpen: (id: string) => void;
  onEdit: (member: GroupMember) => void;
}) {
  const live = liveGroupDeliveries(group.messages);
  return (
    <div className="gc-members" data-testid="group-members" aria-label={copy('Group members', '群聊成员')}>
      {group.members.map(member => {
        const session = sessions.find(row => row.id === member.sessionId);
        const state = groupMemberStatus(member, session, group.messages);
        const active = live.find(row => row.delivery.sessionId === member.sessionId && row.delivery.state === 'working');
        const elapsed = active && deliveryElapsed(active.delivery, now);
        const activity = state === 'failed' && member.error ? groupIssueText({ code: member.error }, zh) : state === 'working' ? groupActivity(session) : undefined;
        const readOnlyNote = groupReadOnlyNote(member.readOnlyNote, zh);
        return (
          <div className="gc-member" data-handle={member.handle} data-state={state} key={member.sessionId}
            title={member.error ? groupIssueTitle({ code: member.error }) : activity || readOnlyNote}>
            <button className="btn btn-sm btn-ghost gc-member-main" title={`@${member.handle}${activity ? ` · ${activity}` : ''}`}
              aria-label={copy(`Open @${member.handle}'s chat`, `打开 @${member.handle} 的对话`)}
              onClick={() => onOpen(member.sessionId)}>
              <AgentIcon provider={member.provider} size={16} /><strong>@{member.handle}</strong>
            </button>
            <GroupStatus state={state} copy={copy} />
            {state === 'working' && elapsed !== undefined && <time>{formatChatDuration(elapsed, zh)}</time>}
            {member.mode === 'read_only' && (
              <span className="chip flat gc-read-only" role="img" aria-label={copy('Read-only', '只读')}
                title={readOnlyNote ?? (member.readOnly === 'enforced'
                  ? copy('Read-only enforced', '已强制只读') : copy('Read-only by instruction', '按说明只读'))}>
                <Icon name="shield" />
              </span>
            )}
            <button className="icon-btn icon-btn-sm" aria-label={copy(`More @${member.handle}`, `更多 @${member.handle} 操作`)}
              disabled={disabled} onClick={() => onEdit(member)}><Icon name="more" /></button>
          </div>
        );
      })}
    </div>
  );
}
