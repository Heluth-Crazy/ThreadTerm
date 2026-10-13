import { Icon } from './PrototypeIcon';
import type { MentionGroup, MentionItem } from '../chatMentions';
import './mentions.css';

const groupIcons: Record<MentionGroup['id'], string> = { files: 'file', sessions: 'layers', commits: 'clock', agents: 'export', skills: 'spark' };

export function mentionGroupLabel(id: MentionGroup['id'], zh: boolean): string {
  return zh
    ? ({ files: '文件', sessions: '会话', commits: '提交', agents: '代理', skills: '技能' })[id]
    : ({ files: 'Files', sessions: 'Sessions', commits: 'Commits', agents: 'Agents', skills: 'Skills' })[id];
}

/**
 * The `@` popup above the composer, in the slash panel's slot. It receives the
 * already filtered groups and the flat active index; it owns no data loading.
 */
export function ChatMentions({ groups, index, zh, onHover, onPick }: {
  groups: readonly MentionGroup[];
  index: number;
  zh: boolean;
  onHover: (index: number) => void;
  onPick: (item: MentionItem) => void;
}) {
  const copy = (en: string, cn: string) => zh ? cn : en;
  if (!groups.length) return <div className="chat-slash chat-mentions" role="listbox" aria-label={copy('Mentions', '提及')}>
    <p className="chat-slash-empty">{copy('No matching files, sessions, commits, agents or skills', '没有匹配的文件、会话、提交、代理或技能')}</p>
  </div>;
  let flat = -1;
  return <div className="chat-slash chat-mentions" role="listbox" aria-label={copy('Mentions', '提及')}>
    {groups.map(group => <div className="mention-group" role="group" aria-label={mentionGroupLabel(group.id, zh)} key={group.id}>
      <div className="mention-group-head"><span>{mentionGroupLabel(group.id, zh)}</span>{group.total > group.items.length && <small>{copy('More results — keep typing to filter', '更多结果——继续输入以筛选')}</small>}</div>
      {group.items.map(item => {
        flat += 1;
        const active = flat === index;
        return <button type="button" role="option" aria-selected={active} className={active ? 'active' : ''} data-testid="mention-option" data-mention-group={group.id} key={item.id} onMouseEnter={() => onHover(flat)} onMouseDown={event => event.preventDefault()} onClick={() => onPick(item)}>
          <Icon name={groupIcons[group.id]}/><b>{item.label}</b>{item.detail && <span>{item.detail}</span>}
        </button>;
      })}
    </div>)}
  </div>;
}
