import { useEffect, useRef } from 'react';
import { AlertTriangle, FileWarning, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DirtyCloseChoice } from './useWorkspaceSession';

interface DirtyTabCloseDialogProps {
  open: boolean;
  titles: string[];
  conflict?: boolean;
  onChoose: (choice: DirtyCloseChoice) => void;
}

export function DirtyTabCloseDialog({
  open,
  titles,
  conflict = false,
  onChoose,
}: DirtyTabCloseDialogProps) {
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
          aria-labelledby="dirty-tab-close-title"
          data-testid="dirty-tab-close-dialog"
          className="pointer-events-auto w-full max-w-md overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-warning/15 text-warning">
                {conflict ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <FileWarning className="h-4 w-4" />
                )}
              </div>
              <h2 id="dirty-tab-close-title" className="text-base font-semibold">
                {conflict
                  ? t('workspace.dirtyCloseConflictTitle', {
                      defaultValue: 'File conflict',
                    })
                  : t('workspace.dirtyCloseTitle', {
                      defaultValue: 'Unsaved changes',
                    })}
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
            {conflict ? (
              <p>
                {t('workspace.dirtyCloseConflictBody', {
                  defaultValue:
                    'Disk content changed while a draft was open. Keep the tab open and resolve the conflict before closing.',
                })}
              </p>
            ) : (
              <p>
                {t('workspace.dirtyCloseBody', {
                  count: titles.length,
                  defaultValue:
                    titles.length === 1
                      ? 'Save changes before closing, or discard them?'
                      : 'Save or discard changes in {{count}} tabs before closing?',
                })}
              </p>
            )}
            {titles.length > 0 && (
              <ul className="max-h-28 list-inside list-disc overflow-y-auto font-mono text-[11px] text-foreground/80">
                {titles.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => onChoose('cancel')}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t('workspace.dirtyCloseCancel', { defaultValue: 'Cancel' })}
            </button>
            {!conflict && (
              <>
                <button
                  type="button"
                  onClick={() => onChoose('discardAndClose')}
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20"
                >
                  {t('workspace.dirtyCloseDiscard', {
                    defaultValue: 'Discard and close',
                  })}
                </button>
                <button
                  ref={defaultButtonRef}
                  type="button"
                  onClick={() => onChoose('saveAndClose')}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t('workspace.dirtyCloseSave', {
                    defaultValue: 'Save and close',
                  })}
                </button>
              </>
            )}
            {conflict && (
              <button
                ref={defaultButtonRef}
                type="button"
                onClick={() => onChoose('cancel')}
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('workspace.dirtyCloseKeepOpen', { defaultValue: 'Keep open' })}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
