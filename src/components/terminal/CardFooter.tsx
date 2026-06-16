import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, BellRing, Trash2 } from 'lucide-react';
import type { TerminalCard as TerminalCardType } from '../../types/terminal';
import type { AiCliSessionBadge } from './providerSession';
import { AiIntentSelect } from './AiIntentSelect';
import { CardActions, type CardActionDensity } from './CardActions';
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
  onArchive?: () => void;
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

export function getCardFooterDensity(width: number): CardActionDensity {
  if (width <= 0) return 'wide';
  if (width < 300) return 'narrow';
  if (width < 360) return 'compact';
  return 'wide';
}

function useCardFooterDensity() {
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<CardActionDensity>('wide');

  useEffect(() => {
    const node = footerRef.current;
    if (!node) return;

    const updateDensity = (width: number) => {
      setDensity(getCardFooterDensity(width));
    };

    updateDensity(node.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => updateDensity(node.getBoundingClientRect().width);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.getBoundingClientRect().width;
      updateDensity(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { footerRef, density };
}

export function CardFooter({
  card,
  aiSessionBadge,
  attentionHint,
  pinned,
  pinFull,
  onCopyCwd,
  onOpenDir,
  onTogglePin,
  onArchive,
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
  const { footerRef, density } = useCardFooterDensity();
  const showInlineAiIntent = Boolean(aiSessionBadge && density === 'wide');
  const overflowAiIntent =
    aiSessionBadge && density !== 'wide' ? (
      <AiIntentSelect cardId={card.id} value={card.aiIntent} compact />
    ) : null;

  // Quick actions on the left, attention hint as a truncating middle band,
  // attention state in the middle, intent select + close on the right. Narrow
  // card widths move optional actions into the More menu so the close button
  // and core actions stay reachable.
  return (
    <div
      ref={footerRef}
      data-card-footer-density={density}
      className="flex shrink-0 items-center border-t border-white/10/40 bg-muted/20 px-1 py-1.5 overflow-hidden sm:px-1.5"
    >
      <div className="flex shrink-0 items-center scale-90 origin-left sm:scale-100">
        <CardActions
          pinned={pinned}
          pinFull={pinFull}
          onCopyCwd={onCopyCwd}
          onOpenDir={onOpenDir}
          onTogglePin={onTogglePin}
          onArchive={onArchive}
          autoRestartEnabled={autoRestartEnabled}
          autoRestartMaxRetries={autoRestartMaxRetries}
          onToggleAutoRestart={onToggleAutoRestart}
          onChangeAutoRestartMaxRetries={onChangeAutoRestartMaxRetries}
          onExportAiSession={onExportAiSession}
          aiSessionExporting={aiSessionExporting}
          aiSessionExportStatus={aiSessionExportStatus}
          density={density}
          overflowContent={overflowAiIntent}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center px-0.5" title={attentionHint ?? undefined}>
        {attentionHint && (
          <span
            className={`inline-flex items-center gap-0.5 text-[10px] ${
              card.status === 'failed' ? 'text-red-500' : 'text-amber-600'
            }`}
          >
            {card.status === 'failed' ? (
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <BellRing className="h-3.5 w-3.5 shrink-0" />
            )}
            {/* Never show text hint in grid cards footer, icons are enough for small space */}
          </span>
        )}
        <div className="shrink-0 scale-90">
          <AutoRestartStatus card={card} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 ml-auto">
        {showInlineAiIntent && (
          <div className="max-w-[70px] sm:max-w-none overflow-hidden">
            <AiIntentSelect cardId={card.id} value={card.aiIntent} compact />
          </div>
        )}
        <button
          type="button"
          title={t('card.close')}
          onClick={stopPropagation(onClose)}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
