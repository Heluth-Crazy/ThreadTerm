import { useEffect, useRef } from 'react';
import { AlertTriangle, LoaderCircle, SquareTerminal, X } from 'lucide-react';
import type {
  TerminalCloseChoice,
  TerminalClosePhase,
  TerminalCloseResult,
} from './types';
import { useI18n } from '../i18n';

export interface TerminalCloseSheetProps {
  open: boolean;
  title: string;
  phase?: TerminalClosePhase;
  stage?: TerminalCloseResult['stage'];
  message?: string;
  /** Read-only devices never see/allow end-terminal. */
  canEndTerminal: boolean;
  onChoose: (choice: TerminalCloseChoice) => void;
}

export function TerminalCloseSheet({
  open,
  title,
  phase = 'confirm',
  stage,
  message,
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
        if (phase === 'confirm') onChoose('cancel');
        else if (phase === 'timedOut' || phase === 'error') onChoose('keepTerminal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose, open, phase]);

  if (!open) return null;

  return (
    <div className="mobile-sheet-root" data-testid="terminal-close-sheet">
      <button
        type="button"
        className="mobile-sheet-backdrop"
        aria-label={zh ? '取消' : 'Cancel'}
        onClick={() => {
          if (phase === 'confirm') onChoose('cancel');
          else if (phase === 'timedOut' || phase === 'error') onChoose('keepTerminal');
        }}
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
          {(phase === 'confirm' || phase === 'timedOut' || phase === 'error') && (
            <button
              type="button"
              className="mobile-icon-button"
              onClick={() => onChoose(phase === 'confirm' ? 'cancel' : 'keepTerminal')}
              aria-label={zh ? '关闭' : 'Close'}
            >
              <X size={18} />
            </button>
          )}
        </header>
        <div className="mobile-sheet-body">
          {phase === 'confirm' && (
            <>
              <p>
                {zh
                  ? `关闭「${title}」？仅关闭标签会同步到其他设备，终端与 Agent 继续运行。`
                  : `Close “${title}”? Closing the tab syncs to other devices; the terminal keeps running.`}
              </p>
              <p className="mobile-sheet-hint">
                <AlertTriangle size={14} />
                <span>
                  {zh
                    ? '默认是「仅关闭标签」。「结束 Agent 并关闭」会先请求 Agent 与 shell 正常退出。'
                    : 'Default is “Close tab only”. “End Agent and close” first requests a clean exit.'}
                </span>
              </p>
            </>
          )}
          {(phase === 'gracefulEnding' || phase === 'forcing') && (
            <p className="mobile-sheet-hint" role="status">
              <LoaderCircle size={16} />
              <span>
                {phase === 'forcing'
                  ? zh
                    ? '正在强制结束终端…'
                    : 'Force ending the terminal…'
                  : zh
                    ? '正在停止当前工作，并等待 Agent 与 shell 正常退出…'
                    : 'Stopping current work and waiting for the Agent and shell to exit…'}
              </span>
            </p>
          )}
          {phase === 'timedOut' && (
            <p className="mobile-info-card warning compact" role="alert">
              <AlertTriangle size={14} />
              <span>
                {zh
                  ? `5 秒内未退出；终端仍在运行，尚未强制结束。${stage ? ` 阶段：${stage}` : ''}`
                  : `The terminal did not exit within 5 seconds and is still running.${stage ? ` Stage: ${stage}` : ''}`}
              </span>
            </p>
          )}
          {phase === 'error' && (
            <p className="mobile-info-card warning compact" role="alert">
              <AlertTriangle size={14} />
              <span>{message || (zh ? '无法正常结束终端。' : 'The terminal could not be ended cleanly.')}</span>
            </p>
          )}
          {phase === 'confirm' && !canEndTerminal && (
            <p className="mobile-info-card warning compact" data-testid="terminal-end-blocked">
              {zh ? '只读设备不能结束终端。' : 'Read-only devices cannot end the terminal.'}
            </p>
          )}
        </div>
        <footer className="mobile-sheet-actions">
          {phase === 'confirm' && (
            <>
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
                  {zh ? '结束 Agent 并关闭' : 'End Agent and close'}
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
            </>
          )}
          {(phase === 'timedOut' || phase === 'error') && (
            <>
              {canEndTerminal && (
                <>
                  <button type="button" className="sheet-btn danger" onClick={() => onChoose('forceEnd')}>
                    {zh ? '强制结束' : 'Force end'}
                  </button>
                  <button type="button" className="sheet-btn ghost" onClick={() => onChoose('continueWaiting')}>
                    {zh ? '再等 5 秒' : 'Wait 5 more seconds'}
                  </button>
                </>
              )}
              <button ref={defaultRef} type="button" className="sheet-btn primary" onClick={() => onChoose('keepTerminal')}>
                {zh ? '保留终端' : 'Keep terminal'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
