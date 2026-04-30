import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, ExternalLink, Pin, PinOff } from 'lucide-react';
import { MAX_PINNED_CARDS } from '../../stores/terminalStore';

export interface CardActionsProps {
  pinned: boolean;
  pinFull: boolean;
  onCopyCwd?: () => void;
  onOpenDir?: () => void;
  onTogglePin: () => void;
}

const stopPropagation = (fn?: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn?.();
};

export function CardActions({
  pinned,
  pinFull,
  onCopyCwd,
  onOpenDir,
  onTogglePin,
}: CardActionsProps) {
  const { t } = useTranslation('terminal');

  const pinTitle = pinned
    ? t('card.unpin')
    : pinFull
      ? t('card.pinFull', { max: MAX_PINNED_CARDS })
      : t('card.pin');

  const pinClass = pinned
    ? 'text-primary hover:bg-primary/10'
    : pinFull
      ? 'text-muted-foreground/40 cursor-not-allowed'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground';

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        title={t('card.copyPath')}
        onClick={stopPropagation(onCopyCwd)}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Copy className="h-3 w-3" />
      </button>
      <button
        type="button"
        title={t('card.revealProject')}
        onClick={stopPropagation(onOpenDir)}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <ExternalLink className="h-3 w-3" />
      </button>
      <button
        type="button"
        title={pinTitle}
        disabled={pinFull && !pinned}
        onClick={stopPropagation(onTogglePin)}
        className={`rounded p-1 ${pinClass}`}
      >
        {pinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
      </button>
    </div>
  );
}
