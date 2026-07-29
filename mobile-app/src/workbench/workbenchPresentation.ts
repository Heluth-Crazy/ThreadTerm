import type {
  CardMeta,
  MobileAttentionItem,
  MobileExecutionGroup,
} from '@shared/mobile/bridge/protocol';
import type { BridgeConnectionState } from '@shared/mobile/bridge/wsClient';

export type AttentionFilter =
  | 'all'
  | 'approval'
  | 'waiting_input'
  | 'failed'
  | 'review'
  | 'stalled';

export const ATTENTION_FILTERS: Array<{
  id: AttentionFilter;
  zh: string;
  en: string;
}> = [
  { id: 'all', zh: '全部待处理', en: 'All pending' },
  { id: 'approval', zh: '审批', en: 'Approval' },
  { id: 'waiting_input', zh: '待输入', en: 'Input' },
  { id: 'failed', zh: '异常', en: 'Failed' },
  { id: 'review', zh: '待复核', en: 'Review' },
  { id: 'stalled', zh: '无进展', en: 'Stalled' },
];

export function attentionMatchesGroup(
  item: MobileAttentionItem,
  group: MobileExecutionGroup,
): boolean {
  return (
    item.projectPath === group.projectPath &&
    (item.worktreePath || item.projectPath) === group.worktreePath
  );
}

export function cardMatchesGroup(
  card: CardMeta,
  group: MobileExecutionGroup,
): boolean {
  return (
    card.projectPath === group.projectPath &&
    (card.worktreePath || card.projectPath) === group.worktreePath
  );
}

export function cardSearchText(card: CardMeta): string {
  return [
    card.projectName,
    card.projectPath,
    card.worktreePath,
    card.branchLabel,
    card.terminalType,
    card.summaryLine,
    card.lastReplyPreview,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function mobileProjectScopeId(projectPath: string): string {
  return `project:${encodeURIComponent(projectPath)}`;
}

export function attentionSearchText(item: MobileAttentionItem): string {
  return [
    item.title,
    item.detail,
    item.projectName,
    item.projectPath,
    item.worktreePath,
    item.branchLabel,
    item.terminalType,
    item.reasonCode,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function groupSearchText(group: MobileExecutionGroup): string {
  return [
    group.projectName,
    group.projectPath,
    group.worktreePath,
    group.branchLabel,
    group.preview,
    ...group.terminalTypes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function attentionKindLabel(
  kind: MobileAttentionItem['kind'],
  zh: boolean,
): string {
  const labels = {
    approval: zh ? '审批' : 'Approval',
    waiting_input: zh ? '待输入' : 'Input',
    failed: zh ? '异常' : 'Failed',
    review: zh ? '待复核' : 'Review',
    stalled: zh ? '无进展' : 'Stalled',
  };
  return labels[kind];
}

export function groupStatusLabel(
  status: MobileExecutionGroup['status'],
  zh: boolean,
): string {
  const labels = {
    failed: zh ? '异常' : 'Failed',
    attention: zh ? '需关注' : 'Attention',
    stalled: zh ? '无进展' : 'Stalled',
    running: zh ? '正常运行' : 'Running',
    review: zh ? '待复核' : 'Review',
    idle: zh ? '空闲' : 'Idle',
  };
  return labels[status];
}

export function sourceLabel(source: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    structured_request: ['结构化请求', 'Structured request'],
    supervisor_alert: ['Supervisor 信号', 'Supervisor signal'],
    notification: ['未读通知', 'Unread notification'],
    terminal_state: ['终端状态', 'Terminal state'],
  };
  const label = labels[source];
  return label ? label[zh ? 0 : 1] : source.replace(/_/g, ' ');
}

export function reasonLabel(reason: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    structured_approval: [
      '结构化请求正在等待桌面端审批',
      'A structured request awaits desktop approval',
    ],
    structured_input: [
      '结构化请求正在等待用户输入',
      'A structured request awaits user input',
    ],
    supervisor_prompt: [
      'Supervisor 检测到需要用户介入',
      'Supervisor detected required intervention',
    ],
    waiting_state: [
      '终端状态明确为等待输入',
      'Terminal state is waiting for input',
    ],
    failed_state: ['终端已进入失败状态', 'Terminal entered a failed state'],
    completed_unread: [
      '终端已完成且结果仍未读',
      'Terminal completed with an unread result',
    ],
    stalled_running: [
      '运行中的终端超过阈值没有活动',
      'Running terminal exceeded the inactivity threshold',
    ],
  };
  const label = labels[reason];
  return label ? label[zh ? 0 : 1] : reason.replace(/_/g, ' ');
}

export function notificationKindLabel(kind: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    waiting: ['等待输入', 'Waiting for input'],
    completed: ['已完成', 'Completed'],
    failed: ['终端异常', 'Terminal failed'],
    attention: ['需要关注', 'Needs attention'],
  };
  const label = labels[kind];
  return label ? label[zh ? 0 : 1] : kind.replace(/_/g, ' ');
}

export function connectionLabel(
  status: BridgeConnectionState,
  zh: boolean,
): string {
  if (status === 'open') return zh ? '已连接桌面端' : 'Desktop connected';
  if (status === 'connecting' || status === 'reconnecting') {
    return zh ? '正在重新连接' : 'Reconnecting';
  }
  if (status === 'revoked') return zh ? '设备权限已失效' : 'Device access ended';
  return zh ? '离线快照' : 'Offline snapshot';
}

export function worktreeLabel(group: MobileExecutionGroup): string {
  return group.branchLabel || pathLeaf(group.worktreePath || group.projectPath);
}

export function mobileScopeOptionLabel(
  group: MobileExecutionGroup,
  zh: boolean,
): string {
  const label = worktreeLabel(group);
  const scopeLabel =
    label.toLocaleLowerCase() === group.projectName.toLocaleLowerCase()
      ? zh
        ? '主工作树'
        : 'Main worktree'
      : label;
  return `${group.projectName} · ${scopeLabel}`;
}

export function mobileTerminalStatusLabel(
  status: CardMeta['status'],
  zh: boolean,
): string {
  const labels: Record<CardMeta['status'], [string, string]> = {
    idle: ['空闲', 'Idle'],
    running: ['运行中', 'Running'],
    waiting_for_input: ['待输入', 'Input'],
    completed: ['已完成', 'Completed'],
    failed: ['异常', 'Failed'],
  };
  const label = labels[status];
  return label[zh ? 0 : 1];
}

export function pathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed || '—';
}

export function formatRelativeTime(timestamp: number, zh: boolean): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return zh ? '刚刚' : 'now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天前` : `${days}d ago`;
}
