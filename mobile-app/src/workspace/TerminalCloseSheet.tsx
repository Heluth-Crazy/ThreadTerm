import { useEffect, useRef } from 'react';
import { AlertTriangle, SquareTerminal, X } from 'lucide-react';
import type { TerminalCloseChoice } from './types';
import { useI18n } from '../i18n';

export interface TerminalCloseSheetProps {
  open: boolean;
  title: string;
  /** Read-only devices never see/allow end-terminal. */
  canEndTerminal: boolean;
  onChoose: (choice: TerminalCloseChoice) => void;
}

export function TerminalCloseSheet({
  open,
  title,
  canEndTerminal,
  onChoose,
}: TerminalCloseSheetProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const defaultRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    defaultRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onChoose('cancel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose, open]);

  if (!open) return null;

  return (
    <div className="mobile-sheet-root" data-testid="terminal-close-sheet">
      <button
        type="button"
        className="mobile-sheet-backdrop"
        aria-label={zh ? '取消' : 'Cancel'}
        onClick={() => onChoose('cancel')}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-close-title"
        className="mobile-sheet-panel"
      >
        <header className="mobile-sheet-header">
          <span className="mobile-sheet-icon">
            <SquareTerminal size={18} />
          </span>
          <h2 id="terminal-close-title">{zh ? '关闭终端标签' : 'Close terminal tab'}</h2>
          <button type="button" className="mobile-icon-button" onClick={() => onChoose('cancel')} aria-label={zh ? '关闭' : 'Close'}>
            <X size={18} />
          </button>
        </header>
        <div className="mobile-sheet-body">
          <p>
            {zh
              ? `关闭「${title}」？仅关闭标签会同步到其他设备，终端与 Agent 继续运行。`
              : `Close “${title}”? Closing the tab syncs to other devices; the terminal keeps running.`}
          </p>
          <p className="mobile-sheet-hint">
            <AlertTriangle size={14} />
            <span>
              {zh
                ? '默认是「仅关闭标签」。“结束终端”会销毁会话，需额外确认。'
                : 'Default is “Close tab only”. Ending the terminal is destructive.'}
            </span>
          </p>
          {!canEndTerminal && (
            <p className="mobile-info-card warning compact" data-testid="terminal-end-blocked">
              {zh
                ? '只读设备不能结束终端。'
                : 'Read-only devices cannot end the terminal.'}
            </p>
          )}
        </div>
        <footer className="mobile-sheet-actions">
          <button type="button" className="sheet-btn ghost" onClick={() => onChoose('cancel')}>
            {zh ? '取消' : 'Cancel'}
          </button>
          {canEndTerminal && (
            <button
              type="button"
              className="sheet-btn danger"
              onClick={() => onChoose('closeAndEnd')}
              data-testid="terminal-close-and-end"
            >
              {zh ? '关闭标签并结束终端' : 'Close tab and end terminal'}
            </button>
          )}
          <button
            ref={defaultRef}
            type="button"
            className="sheet-btn primary"
            onClick={() => onChoose('closeTabOnly')}
            data-testid="terminal-close-tab-only"
          >
            {zh ? '仅关闭标签' : 'Close tab only'}
          </button>
        </footer>
      </div>
    </div>
  );
}
