import { Plus, TerminalSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface WorkbenchEmptyTerminalStateProps {
  scopeLabel: string | null;
  onCreateTerminal: () => void;
}

export function WorkbenchEmptyTerminalState({
  scopeLabel,
  onCreateTerminal,
}: WorkbenchEmptyTerminalStateProps) {
  const { t } = useTranslation('terminal');

  return (
    <div className="mt-5 flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/35 px-6 text-center">
      <TerminalSquare className="h-7 w-7 text-muted-foreground/60" />
      <div className="mt-3 text-sm font-medium">
        {scopeLabel
          ? t('workbench.empty.noScopeTerminalsTitle', {
              defaultValue: 'No terminals in this scope',
            })
          : t('workbench.empty.noTerminalsTitle', {
              defaultValue: 'No terminals yet',
            })}
      </div>
      <div className="mt-1 max-w-sm text-[11px] text-muted-foreground">
        {scopeLabel
          ? t('workbench.empty.noScopeTerminalsBody', {
              defaultValue:
                'Choose another project or worktree, or create a terminal in this scope.',
            })
          : t('workbench.empty.noTerminalsBody', {
              defaultValue:
                'Create a terminal to start collecting local status signals.',
            })}
      </div>
      <button
        type="button"
        onClick={onCreateTerminal}
        className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[11px] font-semibold text-primary-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('app.newTerminal', { defaultValue: 'New terminal' })}
      </button>
    </div>
  );
}
