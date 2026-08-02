import { useEffect, useRef } from 'react';
import { AlertTriangle, TerminalSquare, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TerminalCloseChoice } from './useWorkspaceSession';

interface TerminalTabCloseDialogProps {
  open: boolean;
  title: string;
  onChoose: (choice: TerminalCloseChoice) => void;
}

export function TerminalTabCloseDialog({
  open,
  title,
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
        onChoose('cancel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose, open]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
        onClick={() => onChoose('cancel')}
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
            <button
              type="button"
              onClick={() => onChoose('cancel')}
              aria-label={t('common.close', { defaultValue: 'Close' })}
              className="rounded-md p-1 hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3 px-5 py-4 text-sm text-muted-foreground">
            <p>
              {t('workspace.terminalCloseBody', {
                title,
                defaultValue:
                  'Close “{{title}}”? Closing the tab syncs to other devices, but the terminal and agent keep running if you only close the tab.',
              })}
            </p>
            <p className="flex items-start gap-2 text-[12px]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {t('workspace.terminalCloseHint', {
                  defaultValue:
                    '“Close tab only” is the default. Ending the terminal is destructive and stops the session.',
                })}
              </span>
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
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
                defaultValue: 'Close tab and end terminal',
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
          </div>
        </div>
      </div>
    </>
  );
}
