import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  type LucideIcon,
} from 'lucide-react';
import { MAX_PINNED_CARDS } from '../../stores/terminalStore';
import { AutoRestartControls } from './AutoRestartControls';

export type CardActionDensity = 'wide' | 'compact' | 'narrow';

export interface CardActionsProps {
  pinned: boolean;
  pinFull: boolean;
  onCopyCwd?: () => void;
  onOpenDir?: () => void;
  onTogglePin: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  autoRestartEnabled?: boolean;
  autoRestartMaxRetries?: number;
  onToggleAutoRestart?: () => void;
  onChangeAutoRestartMaxRetries?: (value: number) => void;
  onExportAiSession?: () => void;
  aiSessionExporting?: boolean;
  aiSessionExportStatus?: 'saved' | 'error' | null;
  density?: CardActionDensity;
  overflowContent?: ReactNode;
}

const stopPropagation = (fn?: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn?.();
};

const stopMenuPropagation = (event: MouseEvent<HTMLElement>) => {
  event.stopPropagation();
};

interface OverflowMenuRect {
  left: number;
  top: number;
  width: number;
  placement: 'top' | 'bottom';
}

interface CardActionOverflowMenuProps {
  label: string;
  children: ReactNode;
}

function CardActionOverflowMenu({ label, children }: CardActionOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<OverflowMenuRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const syncMenuRect = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportPadding = 8;
    const menuWidth = 192;
    const left = Math.min(
      Math.max(viewportPadding, rect.right - menuWidth),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const placement = rect.top > 220 ? 'top' : 'bottom';
    setMenuRect({
      left,
      top: placement === 'top' ? rect.top - 4 : rect.bottom + 4,
      width: menuWidth,
      placement,
    });
  };

  const toggleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    syncMenuRect();
    setOpen((current) => !current);
  };

  useEffect(() => {
    if (!open) return;
    syncMenuRect();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (buttonRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onReposition = () => syncMenuRect();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleOpen}
        onMouseDown={stopMenuPropagation}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <MoreHorizontal className="h-3 w-3" />
      </button>
      {open && menuRect && createPortal(
        <div
          ref={menuRef}
          role="menu"
          onClick={stopMenuPropagation}
          onMouseDown={stopMenuPropagation}
          className="fixed z-[9999] flex max-h-[min(320px,calc(100vh-16px))] flex-col gap-1 overflow-y-auto rounded-[var(--radius-md)] border border-white/10 bg-popover p-1.5 text-xs text-popover-foreground shadow-xl"
          style={{
            left: menuRect.left,
            top: menuRect.top,
            width: menuRect.width,
            transform: menuRect.placement === 'top' ? 'translateY(-100%)' : undefined,
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

interface OverflowActionItemProps {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  statusLabel?: string | null;
  onClick?: () => void;
}

function OverflowActionItem({
  icon: Icon,
  label,
  disabled = false,
  statusLabel = null,
  onClick,
}: OverflowActionItemProps) {
  const iconClassName = `h-3.5 w-3.5 shrink-0 ${Icon === Loader2 ? 'animate-spin' : ''}`;

  return (
    <button
      type="button"
      role="menuitem"
      title={label}
      disabled={disabled}
      onClick={stopPropagation(onClick)}
      className="inline-flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className={iconClassName} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {statusLabel && (
        <span className="sr-only" role="status" aria-live="polite">
          {statusLabel}
        </span>
      )}
    </button>
  );
}

export function CardActions({
  pinned,
  pinFull,
  onCopyCwd,
  onOpenDir,
  onTogglePin,
  onRename,
  onArchive,
  autoRestartEnabled = false,
  autoRestartMaxRetries = 3,
  onToggleAutoRestart,
  onChangeAutoRestartMaxRetries,
  onExportAiSession,
  aiSessionExporting = false,
  aiSessionExportStatus = null,
  density = 'wide',
  overflowContent = null,
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
  const showRevealInline = density !== 'narrow';
  const showWideActionsInline = density === 'wide';
  const overflowLabel = t('bottomBar.overflow', { defaultValue: 'More' });
  const autoRestartControls =
    onToggleAutoRestart && onChangeAutoRestartMaxRetries
      ? {
          onToggle: onToggleAutoRestart,
          onMaxRetriesChange: onChangeAutoRestartMaxRetries,
        }
      : null;
  const hasOverflowMenu = density !== 'wide';

  const pinIcon = pinned ? Pin : PinOff;
  const exportIcon = aiSessionExporting ? Loader2 : Download;

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
      {showRevealInline && (
        <button
          type="button"
          title={t('card.revealProject')}
          onClick={stopPropagation(onOpenDir)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      )}
      {showWideActionsInline && (
        <button
          type="button"
          title={pinTitle}
          disabled={pinFull && !pinned}
          onClick={stopPropagation(onTogglePin)}
          className={`rounded p-1 transition-colors ${pinClass}`}
        >
          {pinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
        </button>
      )}
      {showWideActionsInline && onArchive && (
        <button
          type="button"
          title={t('card.archive')}
          onClick={stopPropagation(onArchive)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Archive className="h-3 w-3" />
        </button>
      )}
      {showWideActionsInline && onExportAiSession && (
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
      {showWideActionsInline && autoRestartControls && (
        <div className="scale-90 origin-left">
          <AutoRestartControls
            enabled={autoRestartEnabled}
            maxRetries={autoRestartMaxRetries}
            onToggle={autoRestartControls.onToggle}
            onMaxRetriesChange={autoRestartControls.onMaxRetriesChange}
          />
        </div>
      )}
      {hasOverflowMenu && (
        <CardActionOverflowMenu label={overflowLabel}>
          {density === 'narrow' && (
            <OverflowActionItem icon={ExternalLink} label={t('card.revealProject')} onClick={onOpenDir} />
          )}
          {onRename && (
            <OverflowActionItem
              icon={Pencil}
              label={t('card.rename', { defaultValue: 'Rename' })}
              onClick={onRename}
            />
          )}
          <OverflowActionItem
            icon={pinIcon}
            label={pinTitle}
            disabled={pinFull && !pinned}
            onClick={onTogglePin}
          />
          {onArchive && (
            <OverflowActionItem icon={Archive} label={t('card.archive')} onClick={onArchive} />
          )}
          {onExportAiSession && (
            <OverflowActionItem
              icon={exportIcon}
              label={exportActionLabel}
              disabled={aiSessionExporting}
              statusLabel={exportStatusLabel}
              onClick={onExportAiSession}
            />
          )}
          {autoRestartControls && (
            <div className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px] text-foreground">
              <span className="min-w-0 flex-1 truncate">{t('autoRestart.enable')}</span>
              <AutoRestartControls
                enabled={autoRestartEnabled}
                maxRetries={autoRestartMaxRetries}
                onToggle={autoRestartControls.onToggle}
                onMaxRetriesChange={autoRestartControls.onMaxRetriesChange}
              />
            </div>
          )}
          {overflowContent && (
            <div className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[11px] text-foreground">
              <span className="min-w-0 flex-1 truncate">{t('aiIntent.label')}</span>
              <div className="shrink-0">{overflowContent}</div>
            </div>
          )}
        </CardActionOverflowMenu>
      )}
    </div>
  );
}
