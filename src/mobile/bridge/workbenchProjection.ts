import type {
  NotificationEntry as DesktopNotificationEntry,
  NotificationRouting,
} from '../../types/terminal';
import type {
  AttentionItem,
  ExecutionContextGroup,
  ProjectWorkbenchOverview,
  WorkbenchRules,
  WorkbenchSummary,
} from '../../lib/workbench/types';
import type {
  MobileAttentionItem,
  MobileExecutionGroup,
  MobileProjectWorkbenchOverview,
  MobileWorkbenchProjection,
  NotificationEntry,
} from './protocol';

const MAX_ATTENTION_ITEMS = 100;
const MAX_EXECUTION_GROUPS = 100;
const MAX_NOTIFICATIONS = 100;
const MAX_DETAIL_LENGTH = 2_000;
const MAX_PREVIEW_LENGTH = 1_000;

export interface MobileWorkbenchProjectionInput {
  generatedAt: number;
  summary: WorkbenchSummary;
  attentionItems: readonly AttentionItem[];
  groups: readonly ExecutionContextGroup[];
  followedCardIds: readonly string[];
  projectOverviews: readonly ProjectWorkbenchOverview[];
  rules: WorkbenchRules;
}

export function buildMobileWorkbenchProjection({
  generatedAt,
  summary,
  attentionItems,
  groups,
  followedCardIds,
  projectOverviews,
  rules,
}: MobileWorkbenchProjectionInput): MobileWorkbenchProjection {
  return {
    generatedAt,
    summary: {
      attention: summary.attention,
      normalRunning: summary.normalRunning,
      review: summary.review,
      failed: summary.failed,
    },
    attentionItems: attentionItems
      .slice(0, MAX_ATTENTION_ITEMS)
      .map(toMobileAttentionItem),
    executionGroups: groups
      .slice(0, MAX_EXECUTION_GROUPS)
      .map(toMobileExecutionGroup),
    followedCardIds: [...followedCardIds],
    projectOverviews: projectOverviews.map(toMobileProjectOverview),
    rules: {
      includeWaiting: rules.includeWaiting,
      includeFailed: rules.includeFailed,
      includeCompletedReview: rules.includeCompletedReview,
      stalledEnabled: rules.stalledEnabled,
      stalledThresholdMinutes: rules.stalledThresholdMinutes,
      stalledExcludedCount: rules.stalledExcludedCardIds.length,
    },
    capabilities: {
      openTerminal: true,
      respondToStructuredRequest: false,
      updateRules: false,
      updateNotificationReadState: false,
    },
  };
}

export function notificationsToMobile(
  notifications: readonly DesktopNotificationEntry[],
): NotificationEntry[] {
  return notifications.slice(0, MAX_NOTIFICATIONS).map((entry) => ({
    id: entry.id,
    cardId: entry.cardId,
    kind: entry.kind,
    message: entry.body || entry.title,
    createdAt: entry.at,
    title: entry.title,
    body: entry.body,
    read: entry.read,
    routing: toMobileNotificationRouting(entry.routing),
  }));
}

function toMobileAttentionItem(item: AttentionItem): MobileAttentionItem {
  return {
    id: item.id,
    cardId: item.cardId,
    kind: item.kind,
    severity: item.severity,
    sourceKind: item.sourceKind,
    sourceId: item.sourceId,
    occurredAt: item.occurredAt,
    projectPath: item.projectPath,
    projectName: item.projectName,
    worktreePath: item.worktreePath ?? null,
    branchLabel: item.branchLabel ?? null,
    terminalType: item.terminalType,
    title: item.title,
    detail: truncate(item.detail, MAX_DETAIL_LENGTH),
    reasonCode: item.reasonCode,
    capability: {
      openRequest: item.capability.openRequest,
      openTerminal: item.capability.openTerminal,
      openNotification: item.capability.openNotification,
      openEvidence: item.capability.openEvidence,
    },
  };
}

function toMobileExecutionGroup(group: ExecutionContextGroup): MobileExecutionGroup {
  return {
    id: group.id,
    projectPath: group.projectPath,
    projectName: group.projectName,
    worktreePath: group.worktreePath,
    branchLabel: group.branchLabel ?? null,
    cardIds: [...group.cardIds],
    terminalCount: group.terminalCount,
    terminalTypes: [...group.terminalTypes],
    attentionCount: group.attentionCount,
    status: group.status,
    terminalStatuses: [...group.terminalStatuses],
    lastActivity: group.lastActivity,
    preview: truncate(group.preview, MAX_PREVIEW_LENGTH),
  };
}

function toMobileProjectOverview(
  project: ProjectWorkbenchOverview,
): MobileProjectWorkbenchOverview {
  return {
    projectPath: project.projectPath,
    projectName: project.projectName,
    followedCount: project.followedCount,
    runningCount: project.runningCount,
    attentionCount: project.attentionCount,
    reviewCount: project.reviewCount,
    failedCount: project.failedCount,
  };
}

function toMobileNotificationRouting(
  routing: NotificationRouting | undefined,
): NotificationEntry['routing'] {
  if (!routing) return null;
  return {
    origin: routing.origin,
    family: routing.family,
    episodeKey: routing.episodeKey ?? null,
    fingerprint: routing.fingerprint ?? null,
    signalSource: routing.signalSource ?? null,
    confidence: routing.confidence ?? null,
  };
}

function truncate(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
