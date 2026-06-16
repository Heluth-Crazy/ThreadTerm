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

export interface CardHeaderProps {
  card: TerminalCardType;
  aiSessionBadge: AiCliSessionBadge | null;
  dragHandle?: ReactNode;
}

export function CardHeader({ card, aiSessionBadge, dragHandle }: CardHeaderProps) {
  const { t } = useTranslation('terminal');
  const typeMeta = getTerminalTypeMeta(card.terminalType);
  const TypeIcon = typeMeta.Icon;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-white/10/60 px-3 py-1.5">
      {dragHandle}
      <div
        className={`flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] bg-muted ${typeMeta.accent}`}
      >
        <TypeIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{card.projectName}</span>
          <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
            · {t(`types.${card.terminalType}`, typeMeta.label)}
          </span>
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
      </div>
      <AutoRestartStatus card={card} compact />
      <CardStatusBadge status={card.status} />
    </div>
  );
}
