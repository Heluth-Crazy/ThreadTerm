import type {
  AttentionItem,
  WorkbenchAttentionFilter,
} from '../../lib/workbench/types';
import type { TerminalCard } from '../../types/terminal';

export const WORKBENCH_ATTENTION_FILTERS: readonly WorkbenchAttentionFilter[] = [
  'all',
  'approval',
  'waiting',
  'failed',
  'review',
];

export function attentionSearchText(item: AttentionItem): string {
  return [
    item.title,
    item.detail,
    item.projectName,
    item.projectPath,
    item.branchLabel,
    item.worktreePath,
    item.terminalType,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function followedTerminalSearchText(card: TerminalCard): string {
  return [
    card.projectName,
    card.projectPath,
    card.worktreePath,
    card.branchLabel,
    card.terminalType,
    card.lastReplyPreview,
    card.lastOutput,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function workbenchFilterLabel(
  filter: WorkbenchAttentionFilter,
): string {
  switch (filter) {
    case 'all':
      return 'All pending';
    case 'approval':
      return 'Approval';
    case 'waiting':
      return 'Waiting';
    case 'failed':
      return 'Failed';
    case 'review':
      return 'Review';
    case 'stalled':
      return 'No progress';
  }
}
