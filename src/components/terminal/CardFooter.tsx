import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, BellRing, Trash2 } from 'lucide-react';
import type { TerminalCard as TerminalCardType } from '../../types/terminal';
import type { AiCliSessionBadge } from './providerSession';
import { AiIntentSelect } from './AiIntentSelect';
import { CardActions } from './CardActions';
import { AutoRestartStatus } from './AutoRestartStatus';

export interface CardFooterProps {
  card: TerminalCardType;
  aiSessionBadge: AiCliSessionBadge | null;
  attentionHint: string | null;
  pinned: boolean;
  pinFull: boolean;
  onCopyCwd?: () => void;
  onOpenDir?: () => void;
  onTogglePin: () => void;
  autoRestartEnabled: boolean;
  autoRestartMaxRetries: number;
  onToggleAutoRestart: () => void;
  onChangeAutoRestartMaxRetries: (value: number) => void;
  onExportAiSession?: () => void;
  aiSessionExporting?: boolean;
  aiSessionExportStatus?: 'saved' | 'error' | null;
  onClose?: () => void;
}

const stopPropagation = (fn?: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn?.();
};

export function CardFooter({
  card,
  aiSessionBadge,
  attentionHint,
  pinned,
  pinFull,
  onCopyCwd,
  onOpenDir,
  onTogglePin,
  autoRestartEnabled,
  autoRestartMaxRetries,
  onToggleAutoRestart,
  onChangeAutoRestartMaxRetries,
  onExportAiSession,
  aiSessionExporting,
  aiSessionExportStatus,
  onClose,
}: CardFooterProps) {
  const { t } = useTranslation('terminal');

  // Quick actions on the left, attention hint as a truncating middle band,
  // intent select + close on the right. Timer / message count live in the
  // preview header so this row never overflows when the AI intent dropdown
  // is present.
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border/40 bg-muted/20 px-2 py-1">
      <CardActions
        pinned={pinned}
        pinFull={pinFull}
        onCopyCwd={onCopyCwd}
        onOpenDir={onOpenDir}
        onTogglePin={onTogglePin}
        autoRestartEnabled={autoRestartEnabled}
        autoRestartMaxRetries={autoRestartMaxRetries}
        onToggleAutoRestart={onToggleAutoRestart}
        onChangeAutoRestartMaxRetries={onChangeAutoRestartMaxRetries}
        onExportAiSession={onExportAiSession}
        aiSessionExporting={aiSessionExporting}
        aiSessionExportStatus={aiSessionExportStatus}
      />

      <div className="flex min-w-0 flex-1 items-center gap-1" title={attentionHint ?? undefined}>
        {attentionHint && (
          <span
            className={`inline-flex min-w-0 max-w-full items-center gap-0.5 truncate text-[10px] ${
              card.status === 'failed' ? 'text-red-500' : 'text-amber-600'
            }`}
          >
            {card.status === 'failed' ? (
              <AlertCircle className="h-3 w-3 shrink-0" />
            ) : (
              <BellRing className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">{attentionHint}</span>
          </span>
        )}
        <AutoRestartStatus card={card} />
      </div>

      {aiSessionBadge && (
        <div className="shrink-0">
          <AiIntentSelect cardId={card.id} value={card.aiIntent} compact />
        </div>
      )}
      <button
        type="button"
        title={t('card.close')}
        onClick={stopPropagation(onClose)}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
