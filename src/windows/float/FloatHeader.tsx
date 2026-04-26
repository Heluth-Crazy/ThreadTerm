/**
 * FloatHeader — the draggable title bar for the floating-terminal window.
 *
 * Uses Tauri's native drag handling (`data-tauri-drag-region`) so the user
 * can move the window by grabbing this bar, mirroring the feel of a native
 * window title bar even though the actual window has `decorations: false`.
 *
 * Controls (right-aligned):
 *   • Pin / unpin (always-on-top toggle)
 *   • Back to main (recycles the session into the main window)
 *   • Close (hides the window; does NOT kill the PTY session)
 */
import { ChevronsLeftRight, Minus, Pin, PinOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TerminalCard } from '../../types/terminal';
import { getTerminalTypeMeta } from '../../components/terminal/terminalTypeMeta';
import { getStatusMeta } from '../../components/terminal/statusMeta';

export interface FloatHeaderProps {
  card: TerminalCard | null;
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop: () => void;
  onRecycleToMain: () => void;
  onHide: () => void;
}

export function FloatHeader({
  card,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  onRecycleToMain,
  onHide,
}: FloatHeaderProps) {
  const { t: tOverlay } = useTranslation('overlay');
  const { t: tTerminal } = useTranslation('terminal');
  const typeMeta = card ? getTerminalTypeMeta(card.terminalType) : null;
  const statusInfo = card ? getStatusMeta(card.status) : null;
  const TypeIcon = typeMeta?.Icon;
  const StatusIcon = statusInfo?.Icon;

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-card/85 px-2 backdrop-blur select-none"
    >
      {/* Left: card identity */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-2"
      >
        {card && TypeIcon && (
          <div
            data-tauri-drag-region
            className={`flex h-5 w-5 items-center justify-center rounded ${typeMeta?.accent ?? ''}`}
          >
            <TypeIcon className="h-3.5 w-3.5" />
          </div>
        )}
        <div data-tauri-drag-region className="min-w-0">
          <div data-tauri-drag-region className="flex items-center gap-1.5">
            <span
              data-tauri-drag-region
              className="truncate text-xs font-semibold text-card-foreground"
            >
              {card ? card.projectName : tOverlay('float.title')}
            </span>
            {typeMeta && (
              <span
                data-tauri-drag-region
                className="shrink-0 text-[10px] text-muted-foreground"
              >
                · {card ? tTerminal(`types.${card.terminalType}`, typeMeta.label) : typeMeta.label}
              </span>
            )}
          </div>
          {card && (
            <div
              data-tauri-drag-region
              className="truncate text-[10px] text-muted-foreground"
            >
              {card.worktreePath || card.projectPath}
            </div>
          )}
        </div>
        {card && statusInfo && StatusIcon && (
          <span
            data-tauri-drag-region
            className={`ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusInfo.chip}`}
          >
            <StatusIcon
              className={`h-2.5 w-2.5 ${statusInfo.animate ? 'animate-spin' : ''}`}
            />
            {card ? tTerminal(`status.${card.status}`, statusInfo.label) : statusInfo.label}
          </span>
        )}
      </div>

      {/* Right: controls */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          title={alwaysOnTop ? tOverlay('float.disableAlwaysOnTop') : tOverlay('float.enableAlwaysOnTop')}
          onClick={onToggleAlwaysOnTop}
          className={`rounded p-1 ${
            alwaysOnTop
              ? 'text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          }`}
        >
          {alwaysOnTop ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          title={tOverlay('float.recycleToMain')}
          onClick={onRecycleToMain}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <ChevronsLeftRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={tOverlay('float.minimize')}
          onClick={onHide}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={tOverlay('float.close')}
          onClick={onHide}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
