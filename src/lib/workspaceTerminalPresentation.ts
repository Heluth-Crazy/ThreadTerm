import type { TFunction } from 'i18next';
import { deriveAgentSessionTitle } from './agentSessionTitle';
import { getTerminalTypeMeta, type TerminalTypeMeta } from '../components/terminal/terminalTypeMeta';
import type { AgentSessionSummary } from '../types/agentSession';
import type { TerminalCard, TerminalStatus } from '../types/terminal';

export interface WorkspaceTerminalPresentation {
  primaryTitle: string;
  secondaryTitle?: string;
  typeLabel: string;
  Icon: TerminalTypeMeta['Icon'];
  statusLabel: string;
  detailLabels: string[];
  /** Identity details without type/status/activity (branch, intent). */
  contextLabels: string[];
  /** Relative "last activity" label. */
  activityLabel: string;
  tooltip: string;
}

function suffixSessionId(id: string): string {
  return id.length <= 8 ? id : `…${id.slice(-5)}`;
}

function formatRelativeActivity(at: number, now: number, t: TFunction): string {
  const delta = Math.max(0, now - at);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) {
    return t('workspace.activityJustNow', { defaultValue: 'Just now' });
  }
  if (delta < hour) {
    const minutes = Math.floor(delta / minute);
    return t('workspace.activityMinutes', {
      count: minutes,
      defaultValue: '{{count}}m ago',
    });
  }
  if (delta < day) {
    const hours = Math.floor(delta / hour);
    return t('workspace.activityHours', {
      count: hours,
      defaultValue: '{{count}}h ago',
    });
  }
  const days = Math.floor(delta / day);
  return t('workspace.activityDays', {
    count: days,
    defaultValue: '{{count}}d ago',
  });
}

function statusLabel(status: TerminalStatus, t: TFunction): string {
  return t(`status.${status}`, {
    defaultValue: status,
  });
}

/**
 * Pure presentation selector shared by Workspace Home and terminal tabs.
 * Native titles never persist on TerminalCard; they arrive via the metadata cache.
 */
export function buildWorkspaceTerminalPresentation(
  card: TerminalCard,
  options: {
    t: TFunction;
    metadata?: AgentSessionSummary | null;
    now?: number;
  },
): WorkspaceTerminalPresentation {
  const { t, metadata = null } = options;
  const now = options.now ?? Date.now();
  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const typeLabel = t(`types.${card.terminalType}`, typeMeta.label);
  const cardName = card.projectName?.trim() || typeLabel;
  const status = statusLabel(card.status, t);

  let primaryTitle = cardName;
  let secondaryTitle: string | undefined;

  if (
    metadata
    && card.providerSessionState === 'bound'
    && card.providerSessionId
  ) {
    const derived = deriveAgentSessionTitle(metadata);
    if (derived.primary && derived.kind !== 'fallback') {
      primaryTitle = derived.primary;
      if (cardName && cardName !== primaryTitle) {
        secondaryTitle = cardName;
      }
    } else if (derived.kind === 'fallback' && derived.primary) {
      // Prefer ThreadTerm name over "Provider · …id" for workspace identity.
      primaryTitle = cardName;
    }
  }

  const contextLabels: string[] = [];
  if (card.branchLabel?.trim()) {
    contextLabels.push(card.branchLabel.trim());
  }
  if (card.aiIntent) {
    contextLabels.push(
      t(`aiIntent.${card.aiIntent}`, { defaultValue: card.aiIntent }),
    );
  }
  const activityLabel = formatRelativeActivity(card.lastActivity || card.createdAt, now, t);
  const detailLabels: string[] = [typeLabel, status, ...contextLabels, activityLabel];

  const tooltipParts = [primaryTitle];
  if (secondaryTitle) tooltipParts.push(secondaryTitle);
  tooltipParts.push(typeLabel, status);
  if (card.providerSessionId && card.providerSessionState === 'bound') {
    tooltipParts.push(suffixSessionId(card.providerSessionId));
  }

  return {
    primaryTitle,
    secondaryTitle,
    typeLabel,
    Icon: typeMeta.Icon,
    statusLabel: status,
    detailLabels,
    contextLabels,
    activityLabel,
    tooltip: tooltipParts.join(' · '),
  };
}
