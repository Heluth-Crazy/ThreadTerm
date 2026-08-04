import { useEffect, useRef } from 'react';
import { AlertTriangle, LoaderCircle, TerminalSquare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  TerminalCloseChoice,
  TerminalClosePhase,
} from './useWorkspaceSession';
import type { GracefulShutdownStage } from '../../lib/tauri-bridge';

interface TerminalTabCloseDialogProps {
  open: boolean;
  title: string;
  phase?: TerminalClosePhase;
  stage?: GracefulShutdownStage;
  message?: string;
  onChoose: (choice: TerminalCloseChoice) => void;
}

export function TerminalTabCloseDialog({
  open,
  title,
  phase = 'confirm',
  stage,
  message,
  onChoose,
}: TerminalTabCloseDialogProps) {
  const { t } = useTranslation('terminal');
  const defaultButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    defaultButtonRef.current?.focus();
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
    <>
      <div
        className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
        onClick={() => {
          if (phase === 'confirm') onChoose('cancel');
          else if (phase === 'timedOut' || phase === 'error') onChoose('keepTerminal');
        }}
        aria-hidden
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="terminal-tab-close-title"
          data-testid="terminal-tab-close-dialog"
          className="pointer-events-auto w-full max-w-md overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <TerminalSquare className="h-4 w-4" />
              </div>
              <h2 id="terminal-tab-close-title" className="text-base font-semibold">
                {t('workspace.terminalCloseTitle', { defaultValue: 'Close terminal tab' })}
              </h2>
            </div>
            {(phase === 'confirm' || phase === 'timedOut' || phase === 'error') && (
              <button
                type="button"
                onClick={() =>
                  onChoose(phase === 'confirm' ? 'cancel' : 'keepTerminal')
                }
                aria-label={t('common.close', { defaultValue: 'Close' })}
                className="rounded-md p-1 hover:bg-accent hover:text-accent-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="space-y-3 px-5 py-4 text-sm text-muted-foreground">
            {phase === 'confirm' && (
              <>
                <p>
                  {t('workspace.terminalCloseBody', {
                    title,
                    defaultValue:
                      'Close “{{title}}”? Closing the tab syncs to other devices, but the terminal and Agent keep running if you only close the tab.',
                  })}
                </p>
                <p className="flex items-start gap-2 text-[12px]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <span>
                    {t('workspace.terminalCloseHint', {
                      defaultValue:
                        '“Close tab only” is the default. “End Agent and close” first asks the Agent and shell to exit cleanly.',
                    })}
                  </span>
                </p>
              </>
            )}
            {(phase === 'gracefulEnding' || phase === 'forcing') && (
              <p className="flex items-center gap-2" role="status">
                <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
                <span>
                  {phase === 'forcing'
                    ? t('workspace.terminalForceEnding', {
                        defaultValue: 'Force ending the terminal…',
                      })
                    : t('workspace.terminalGracefulEnding', {
                        defaultValue:
                          'Stopping current work and waiting for the Agent and shell to exit…',
                      })}
                </span>
              </p>
            )}
            {phase === 'timedOut' && (
              <>
                <p className="flex items-start gap-2 text-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <span>
                    {t('workspace.terminalGracefulTimeout', {
                      defaultValue:
                        'The terminal did not exit within 5 seconds. It is still running and has not been force ended.',
                    })}
                  </span>
                </p>
                {stage && (
                  <p className="text-xs">
                    {t('workspace.terminalGracefulStage', {
                      stage,
                      defaultValue: 'Waiting stage: {{stage}}',
                    })}
                  </p>
                )}
              </>
            )}
            {phase === 'error' && (
              <p className="flex items-start gap-2 text-destructive" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {message ||
                    t('workspace.terminalGracefulError', {
                      defaultValue: 'The terminal could not be ended cleanly.',
                    })}
                </span>
              </p>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
            {phase === 'confirm' && (
              <>
                <button
                  type="button"
                  onClick={() => onChoose('cancel')}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t('workspace.terminalCloseCancel', { defaultValue: 'Cancel' })}
                </button>
                <button
                  type="button"
                  onClick={() => onChoose('closeAndEnd')}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20"
                >
                  {t('workspace.terminalCloseAndEnd', {
                    defaultValue: 'End Agent and close',
                  })}
                </button>
                <button
                  ref={defaultButtonRef}
                  type="button"
                  onClick={() => onChoose('closeTabOnly')}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t('workspace.terminalCloseTabOnly', { defaultValue: 'Close tab only' })}
                </button>
              </>
            )}
            {(phase === 'timedOut' || phase === 'error') && (
              <>
                <button
                  type="button"
                  onClick={() => onChoose('forceEnd')}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20"
                >
                  {t('workspace.terminalForceEnd', { defaultValue: 'Force end' })}
                </button>
                <button
                  type="button"
                  onClick={() => onChoose('continueWaiting')}
                  className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  {t('workspace.terminalContinueWaiting', {
                    defaultValue: 'Wait 5 more seconds',
                  })}
                </button>
                <button
                  ref={defaultButtonRef}
                  type="button"
                  onClick={() => onChoose('keepTerminal')}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t('workspace.terminalKeepRunning', {
                    defaultValue: 'Keep terminal',
                  })}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
