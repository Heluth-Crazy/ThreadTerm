export type GroupCopy = (en: string, zh: string) => string;

export function groupStatusClass(state: string): string {
  if (state === 'working') return 'st-running';
  if (state === 'needs_user') return 'st-needs';
  if (state === 'failed') return 'st-failed';
  if (state === 'replied' || state === 'stopped') return 'st-ended';
  return 'flat';
}

export function groupStateText(state: string, copy: GroupCopy): string {
  return ({
    working: copy('Working', '进行中'),
    queued: copy('Queued', '已排队'),
    needs_user: copy('Needs you', '需要你处理'),
    replied: copy('Replied', '已回复'),
    idle: copy('Idle', '空闲'),
    failed: copy('Failed', '失败'),
    stopped: copy('Stopped', '已停止'),
  })[state] ?? state;
}

export function GroupStatus({ state, copy }: { state: string; copy: GroupCopy }) {
  return <span className={`chip ${groupStatusClass(state)}`} data-state={state}>{groupStateText(state, copy)}</span>;
}
