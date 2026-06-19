import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { TerminalCard as TerminalCardType } from '../../types/terminal';
import {
  AI_CLI_SESSION_BADGE_CLASS,
  type AiCliSessionBadge,
} from './providerSession';
import { getTerminalTypeMeta } from './terminalTypeMeta';
import { CardStatusBadge } from './CardStatusBadge';
import { AutoRestartStatus } from './AutoRestartStatus';
import { EditableCardName } from './EditableCardName';
import { useStatsStore } from '../../stores/statsStore';
import { formatCost, formatTokens } from '../../lib/statsFormat';

export interface CardHeaderProps {
  card: TerminalCardType;
  aiSessionBadge: AiCliSessionBadge | null;
  dragHandle?: ReactNode;
  /** Whether the title is currently in inline-edit mode. */
  editing: boolean;
  /** Enter edit mode (double-click title / overflow menu "Rename"). */
  onStartEdit: () => void;
  /** Commit the edited name (Enter / blur). */
  onCommitName: (name: string) => void;
  /** Abandon the edit (Escape). */
  onCancelEdit: () => void;
}

export function CardHeader({
  card,
  aiSessionBadge,
  dragHandle,
  editing,
  onStartEdit,
  onCommitName,
  onCancelEdit,
}: CardHeaderProps) {
  const { t } = useTranslation('terminal');
  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const TypeIcon = typeMeta.Icon;
  const tokenBucket = useStatsStore((s) =>
    card.providerSessionId ? s.bySession[card.providerSessionId] : undefined,
  );

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      {dragHandle}
      <div
        className={`flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] bg-muted ${typeMeta.accent}`}
      >
        <TypeIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {/* The title owns its own click region: single-click is stopped so it
              doesn't open the card, double-click enters rename mode. Trade-off:
              click the title to rename, click elsewhere on the card to open. */}
          <div
            className="flex min-w-0 flex-1 items-center"
            onClick={editing ? undefined : (event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (!editing) onStartEdit();
            }}
            title={editing ? undefined : t('card.renameHint', { defaultValue: 'Double-click to rename' })}
          >
            <EditableCardName
              value={card.projectName}
              editing={editing}
              onCommit={onCommitName}
              onCancel={onCancelEdit}
              ariaLabel={t('card.rename', { defaultValue: 'Rename card' })}
            />
          </div>
          {!editing && (
            <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
              · {t(`types.${card.terminalType}`, typeMeta.label)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="truncate">{card.projectPath}</span>
        </div>
        {aiSessionBadge && (
          <div className="mt-0.5 flex">
            <span
              title={t(aiSessionBadge.descriptionKey, {
                ...aiSessionBadge.values,
                defaultValue: aiSessionBadge.fallbackDescription,
              })}
              className={[
                'inline-flex max-w-full items-center rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium leading-none',
                AI_CLI_SESSION_BADGE_CLASS[aiSessionBadge.tone],
              ].join(' ')}
            >
              <span className="truncate">
                {t(aiSessionBadge.labelKey, {
                  ...aiSessionBadge.values,
                  defaultValue: aiSessionBadge.fallbackLabel,
                })}
              </span>
            </span>
          </div>
        )}
        {tokenBucket && (card.terminalType === 'claude' || card.terminalType === 'codex') && (
          <div className="mt-0.5 flex">
            <span
              title={t('stats.title', { defaultValue: 'Token usage' })}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-emerald-500"
            >
              {formatTokens(tokenBucket.totalTokens)} · {formatCost(tokenBucket.costUsd)}
            </span>
          </div>
        )}
      </div>
      <AutoRestartStatus card={card} compact />
      <CardStatusBadge status={card.status} />
    </div>
  );
}
