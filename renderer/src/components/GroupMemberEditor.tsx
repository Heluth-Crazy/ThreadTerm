import { useEffect, useState } from 'react';
import { groupIssueText, groupIssueTitle, groupReadOnlyNote, type GroupIssue } from '../groupMessages';
import type { Group, GroupMember, GroupPrerequisites, ProviderCapability } from '@threadterm/protocol';
import { request } from '../bridge';
import { agentName } from '../agents';
import { Icon } from './PrototypeIcon';
import { Select } from './ui/Select';
import { SurfaceDialog } from './SurfaceDialog';

type Props = {
 group: Group;
 providers: ProviderCapability[];
 member?: GroupMember;
 initialHandle?: string;
 zh: boolean;
 busy: boolean;
 onClose: () => void;
 onSave: (value: { provider: string; handle?: string; mode: 'default' | 'read_only' }) => Promise<void>;
 onRemove: () => Promise<void>;
};

export function GroupMemberEditor({ group, providers, member, initialHandle, zh, busy, onClose, onSave, onRemove }: Props) {
 const copy = (en: string, cn: string) => zh ? cn : en;
 const [provider, setProvider] = useState(member?.provider ?? providers.find(provider => provider.installed && provider.chat)?.id ?? '');
 const [handle, setHandle] = useState(member?.handle ?? initialHandle ?? '');
 const [mode, setMode] = useState<'default' | 'read_only'>(member?.mode ?? 'default');
 const [checks, setChecks] = useState<GroupPrerequisites>();
 const [checkedProvider, setCheckedProvider] = useState('');
 const [issue, setIssue] = useState<GroupIssue>();

 useEffect(() => {
  if (member || !provider) return;
  let active = true;
  void request('group.prerequisites', { cwd: group.cwd, providers: [provider] })
   .then(value => {
    if (!active) return;
    setChecks(value);
    setCheckedProvider(provider);
   })
   .catch(error => {
    if (active) setIssue(error instanceof Error ? { code: error.message } : { en: 'Could not check this agent.', zh: '无法检查此智能体。' });
   });
  return () => { active = false; };
 }, [provider, group.cwd, member?.sessionId]);

 const check = checkedProvider === provider ? checks?.providers[0] : undefined;
 const readOnlyNote = groupReadOnlyNote(member?.readOnlyNote ?? check?.readOnlyNote, zh);
 const prerequisiteText = check && (zh ? `请安装、登录或配置 ${agentName(provider, providers)}，然后刷新提供者。` : check.fix?.text ?? check.reason);
 const validHandle = !handle || (/^[a-z0-9-]{1,24}$/.test(handle) && handle !== 'all' && !group.members.some(row => row.sessionId !== member?.sessionId && row.handle === handle));
 const valid = !!provider && validHandle && (member || check?.usable);
 const save = () => void onSave({ provider, ...(handle ? { handle } : {}), mode });

 return (
  <SurfaceDialog
   title={member ? copy(`Edit @${member.handle}`, `编辑 @${member.handle}`) : copy('Add agent', '添加智能体')}
   onClose={() => { if (!busy) onClose(); }}
   size="sm"
   footer={<>
    {member && <button className="btn" disabled={busy || group.members.length <= 1}
     title={group.members.length <= 1 ? copy('A group needs at least one member.', '群聊至少需要一位成员。') : undefined}
     onClick={() => void onRemove()}>{copy('Remove member', '移除成员')}</button>}
    <button className="btn" disabled={busy} onClick={onClose}>{copy('Cancel', '取消')}</button>
    <button className="btn btn-primary" data-testid="group-add-agent" disabled={busy || !valid} onClick={save}>
     {member ? copy('Save changes', '保存更改') : copy('Add agent', '添加智能体')}
    </button>
   </>}
  >
   <div className="gc-member-form" data-testid={member ? 'group-member-dialog' : 'group-add-dialog'}>
    <label>
     {copy('Provider', '提供者')}
     <Select data-testid="group-add-provider" aria-label={copy('Provider', '提供者')} value={provider}
      disabled={!!member || busy} onChange={event => setProvider(event.target.value)}>
      {providers.filter(row => row.id !== 'shell' && row.id !== 'custom').map(row => (
       <option value={row.id} key={row.id} disabled={!row.installed || !row.chat}>
        {agentName(row.id, providers)}{!row.installed || !row.chat ? ` · ${copy('Unavailable', '不可用')}` : ''}
       </option>
      ))}
     </Select>
    </label>
    <label>
     {copy('Handle', '昵称')}
     <input className="create-input" data-testid="group-add-handle" aria-label={copy('Handle', '昵称')}
      value={handle} placeholder={copy('Automatic handle', '自动生成昵称')} maxLength={24}
      onChange={event => setHandle(event.target.value.toLowerCase().replace(/^@/, ''))} aria-invalid={!validHandle} />
    </label>
    {!validHandle && <div className="gc-notice gc-error" role="alert">
     <Icon name="info" />
     <span>{copy('Use a unique handle: 1–24 lowercase letters, digits or hyphens. All is reserved.', '请使用唯一昵称：1–24 个小写字母、数字或连字符。All 为保留名称。')}</span>
    </div>}
    <label>
     {copy('Mode', '模式')}
     <Select aria-label={copy('Mode', '模式')} value={mode} disabled={busy}
      onChange={event => setMode(event.target.value as typeof mode)}>
      <option value="default">{copy('Normal', '普通')}</option>
      <option value="read_only">{copy('Read-only', '只读')}</option>
     </Select>
    </label>
    {!member && !check && <div className="gc-notice" role="status">
     <Icon name="info" />
     <span>{copy('Checking agent prerequisites…', '正在检查智能体前提条件…')}</span>
    </div>}
    {check && !check.usable && <div className="gc-notice gc-error" role="alert" title={prerequisiteText}>
     <Icon name="info" />
     <span>{prerequisiteText}</span>
    </div>}
    {mode === 'read_only' && <p className="gc-muted" title={readOnlyNote}>
     {(member?.readOnly ?? check?.readOnly) === 'enforced' ? copy('Read-only enforced', '已强制只读') : copy('Read-only by instruction', '按说明只读')}
    </p>}
    {member && <p className="gc-muted">{copy('Removing a member keeps its Chat and history available.', '移除成员会保留其对话及历史记录。')}</p>}
    {issue && <div className="gc-notice gc-error" role="alert" title={groupIssueTitle(issue)}>
     <Icon name="info" />
     <span>{groupIssueText(issue, zh)}</span>
    </div>}
   </div>
  </SurfaceDialog>
 );
}
