import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Copy, Download, ExternalLink, Loader2, Pin, PinOff } from 'lucide-react';
import { MAX_PINNED_CARDS } from '../../stores/terminalStore';
import { AutoRestartControls } from './AutoRestartControls';

export interface CardActionsProps {
  pinned: boolean;
  pinFull: boolean;
  onCopyCwd?: () => void;
  onOpenDir?: () => void;
  onTogglePin: () => void;
  onArchive?: () => void;
  autoRestartEnabled?: boolean;
  autoRestartMaxRetries?: number;
  onToggleAutoRestart?: () => void;
  onChangeAutoRestartMaxRetries?: (value: number) => void;
  onExportAiSession?: () => void;
  aiSessionExporting?: boolean;
  aiSessionExportStatus?: 'saved' | 'error' | null;
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
  onArchive,
  autoRestartEnabled = false,
  autoRestartMaxRetries = 3,
  onToggleAutoRestart,
  onChangeAutoRestartMaxRetries,
  onExportAiSession,
  aiSessionExporting = false,
  aiSessionExportStatus = null,
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
  const exportActionLabel = t('aiExport.exportMarkdown', { defaultValue: 'Export AI Markdown' });
  const exportStatusLabel =
    aiSessionExportStatus === 'saved'
      ? t('aiExport.saved', { defaultValue: 'AI session Markdown exported.' })
      : aiSessionExportStatus === 'error'
        ? t('aiExport.failed', { defaultValue: 'AI session export failed.' })
        : null;

  return (
    <div className="flex shrink-0 items-center gap-0">
      <button
        type="button"
        title={t('card.copyPath')}
        onClick={stopPropagation(onCopyCwd)}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <Copy className="h-3 w-3" />
      </button>
      <button
        type="button"
        title={t('card.revealProject')}
        onClick={stopPropagation(onOpenDir)}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <ExternalLink className="h-3 w-3" />
      </button>
      <button
        type="button"
        title={pinTitle}
        disabled={pinFull && !pinned}
        onClick={stopPropagation(onTogglePin)}
        className={`rounded p-1 transition-colors ${pinClass}`}
      >
        {pinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
      </button>
      {onArchive && (
        <button
          type="button"
          title={t('card.archive')}
          onClick={stopPropagation(onArchive)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Archive className="h-3 w-3" />
        </button>
      )}
      {onExportAiSession && (
        <button
          type="button"
          title={exportActionLabel}
          aria-label={exportActionLabel}
          disabled={aiSessionExporting}
          onClick={stopPropagation(onExportAiSession)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-wait disabled:opacity-50 transition-colors"
        >
          {aiSessionExporting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          {exportStatusLabel && (
            <span className="sr-only" role="status" aria-live="polite">
              {exportStatusLabel}
            </span>
          )}
        </button>
      )}
      {onToggleAutoRestart && onChangeAutoRestartMaxRetries && (
        <div className="scale-90 origin-left">
          <AutoRestartControls
            enabled={autoRestartEnabled}
            maxRetries={autoRestartMaxRetries}
            onToggle={onToggleAutoRestart}
            onMaxRetriesChange={onChangeAutoRestartMaxRetries}
          />
        </div>
      )}
    </div>
  );
}
