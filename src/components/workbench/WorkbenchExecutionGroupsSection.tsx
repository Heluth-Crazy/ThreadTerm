import { useTranslation } from 'react-i18next';
import type { ExecutionContextGroup } from '../../lib/workbench/types';
import { ExecutionGroupCard } from './ExecutionGroupCard';

interface WorkbenchExecutionGroupsSectionProps {
  groups: readonly ExecutionContextGroup[];
  now: number;
  onOpenGroup: (group: ExecutionContextGroup) => void;
  onNavigateTerminals: () => void;
}

export function WorkbenchExecutionGroupsSection({
  groups,
  now,
  onOpenGroup,
  onNavigateTerminals,
}: WorkbenchExecutionGroupsSectionProps) {
  const { t } = useTranslation('terminal');

  return (
    <section aria-labelledby="workbench-groups-heading">
      <div className="mb-2 mt-5 flex items-center gap-2">
        <div className="min-w-0">
          <h2 id="workbench-groups-heading" className="text-[13px] font-semibold">
            {t('workbench.groups.title', { defaultValue: 'Execution contexts' })}
          </h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {t('workbench.groups.subtitle', {
              defaultValue: 'Grouped by project and worktree, not inferred tasks',
            })}
          </p>
        </div>
        <button
          type="button"
          onClick={onNavigateTerminals}
          className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground hover:text-primary"
        >
          {t('workbench.action.viewAllTerminals', {
            defaultValue: 'View all terminals',
          })}
          {' →'}
        </button>
      </div>
      {groups.length > 0 ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {groups.map((group) => (
            <ExecutionGroupCard
              key={group.id}
              group={group}
              now={now}
              onOpenDetail={onOpenGroup}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card/30 px-4 py-5 text-center text-[11px] text-muted-foreground">
          {t('workbench.empty.noActiveContexts', {
            defaultValue: 'No active execution contexts in this scope.',
          })}
        </div>
      )}
    </section>
  );
}
