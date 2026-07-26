import type { TFunction } from 'i18next';
import type {
  AttentionItem,
  AttentionKind,
  ExecutionContextStatus,
} from '../../lib/workbench/types';

export function attentionKindLabel(kind: AttentionKind, t: TFunction<'terminal'>): string {
  return t(`workbench.kind.${kind}`, { defaultValue: defaultAttentionKindLabel(kind) });
}
export function attentionReasonLabel(
  reasonCode: AttentionItem['reasonCode'],
  t: TFunction<'terminal'>,
): string {
  return t(`workbench.reason.${reasonCode}`, {
    defaultValue: defaultReasonLabel(reasonCode),
  });
}

export function executionStatusLabel(
  status: ExecutionContextStatus,
  t: TFunction<'terminal'>,
): string {
  return t(`workbench.groupStatus.${status}`, {
    defaultValue: defaultExecutionStatusLabel(status),
  });
}

export function relativeTime(timestamp: number, now: number, language: string): string {
  const deltaSeconds = Math.round((timestamp - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, 'second');
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, 'minute');
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, 'hour');
  return formatter.format(Math.round(deltaHours / 24), 'day');
}

function defaultAttentionKindLabel(kind: AttentionKind): string {
  switch (kind) {
    case 'approval':
      return 'Approval';
    case 'waiting_input':
      return 'Waiting for input';
    case 'failed':
      return 'Failed';
    case 'review':
      return 'Ready to review';
    case 'stalled':
      return 'No recent progress';
  }
}

function defaultReasonLabel(reasonCode: AttentionItem['reasonCode']): string {
  switch (reasonCode) {
    case 'structured_approval':
      return 'A structured request is waiting for approval.';
    case 'structured_input':
      return 'A structured request needs your input.';
    case 'supervisor_prompt':
      return 'The terminal supervisor detected an interactive prompt.';
    case 'waiting_state':
      return 'The terminal is waiting for input.';
    case 'failed_state':
      return 'The terminal failed and has no pending automatic restart.';
    case 'completed_unread':
      return 'The terminal completed and its result has not been viewed.';
    case 'stalled_running':
      return 'The agent terminal has had no recent activity.';
  }
}

function defaultExecutionStatusLabel(status: ExecutionContextStatus): string {
  switch (status) {
    case 'failed':
      return 'Failed';
    case 'attention':
      return 'Needs attention';
    case 'stalled':
      return 'No progress';
    case 'running':
      return 'Running';
    case 'review':
      return 'Ready to review';
    case 'idle':
      return 'Idle';
  }
}
