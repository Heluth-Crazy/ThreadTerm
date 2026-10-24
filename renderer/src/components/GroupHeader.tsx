import { useState } from 'react';
import type { Group } from '@threadterm/protocol';
import { Icon } from './PrototypeIcon';
import type { GroupCopy } from './GroupStatus';

export function GroupHeader({ group, disabled, copy, onRename, onAdd, onArchive }: {
  group: Group;
  disabled: boolean;
  copy: GroupCopy;
  onRename: (title: string) => Promise<boolean>;
  onAdd: () => void;
  onArchive: () => Promise<boolean>;
}) {
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState('');
  const [menu, setMenu] = useState(false);

  return (
    <header className="gc-header" data-testid="group-header">
      {rename ? (
        <form onSubmit={event => {
          event.preventDefault();
          if (title.trim()) void onRename(title.trim()).then(ok => { if (ok) setRename(false); });
        }}>
          <input className="create-input" data-testid="group-rename-input"
            aria-label={copy('Group name', '群聊名称')} value={title} maxLength={512} autoFocus
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') setRename(false); }} />
          <button className="btn btn-sm" disabled={disabled || !title.trim()}>{copy('Save', '保存')}</button>
          <button className="icon-btn icon-btn-sm" type="button" aria-label={copy('Cancel rename', '取消重命名')}
            onClick={() => setRename(false)}><Icon name="close" /></button>
        </form>
      ) : (
        <button className="btn btn-sm btn-ghost gc-title" title={group.title}
          aria-label={copy('Rename group', '重命名群聊')}
          onClick={() => { setTitle(group.title); setRename(true); }}>
          <Icon name="agents" /><strong>{group.title}</strong>
        </button>
      )}
      <span className="gc-member-count">
        {copy(`${group.members.length} member${group.members.length === 1 ? '' : 's'}`, `${group.members.length} 位成员`)}
      </span>
      {group.archived && <span className="chip flat">{copy('Archived', '已归档')}</span>}
      <button className="btn btn-sm" disabled={disabled || group.archived || group.members.length >= 6} onClick={onAdd}>
        <Icon name="plus" />{copy('Add agent', '添加智能体')}
      </button>
      <div className="gc-menu-anchor">
        <button className="icon-btn icon-btn-sm" aria-label={copy('More group actions', '更多群聊操作')}
          aria-expanded={menu} onClick={() => setMenu(value => !value)}><Icon name="more" /></button>
        {menu && (
          <div className="popover gc-header-menu" role="menu" onKeyDown={event => {
            if (event.key === 'Escape') setMenu(false);
          }}>
            <button className="menu-item" role="menuitem" disabled={disabled}
              onClick={() => void onArchive().then(ok => { if (ok) setMenu(false); })}>
              <Icon name="archive" />
              {group.archived ? copy('Restore group', '恢复群聊') : copy('Archive group', '归档群聊')}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
