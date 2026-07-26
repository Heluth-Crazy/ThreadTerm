import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkbenchStore } from '../../stores/workbenchStore';
import type { TerminalCard } from '../../types/terminal';

interface WorkbenchRulesPanelProps {
  cards: readonly TerminalCard[];
}

export function WorkbenchRulesPanel({ cards }: WorkbenchRulesPanelProps) {
  const { t } = useTranslation('terminal');
  const rules = useWorkbenchStore((state) => state.rules);
  const updateRules = useWorkbenchStore((state) => state.updateRules);
  const toggleStalledExclusion = useWorkbenchStore(
    (state) => state.toggleStalledExclusion,
  );
  const resetRules = useWorkbenchStore((state) => state.resetRules);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-foreground/[0.025] p-2.5 text-[11px] leading-relaxed text-muted-foreground">
        {t('workbench.rules.localOnly', {
          defaultValue:
            'These local rules only decide what appears here. They never send terminal input or restart a process.',
        })}
      </div>

      <div className="space-y-1">
        <RuleSwitch
          label={t('workbench.rules.includeWaiting', {
            defaultValue: 'Waiting for input',
          })}
          description={t('workbench.rules.includeWaitingHint', {
            defaultValue: 'Include structured requests and terminal prompts.',
          })}
          checked={rules.includeWaiting}
          onChange={(checked) => updateRules({ includeWaiting: checked })}
        />
        <RuleSwitch
          label={t('workbench.rules.includeFailed', {
            defaultValue: 'Unrecovered failures',
          })}
          description={t('workbench.rules.includeFailedHint', {
            defaultValue: 'Hide failures while an automatic restart is pending.',
          })}
          checked={rules.includeFailed}
          onChange={(checked) => updateRules({ includeFailed: checked })}
        />
        <RuleSwitch
          label={t('workbench.rules.includeReview', {
            defaultValue: 'Completed results to review',
          })}
          description={t('workbench.rules.includeReviewHint', {
            defaultValue: 'Include completed terminals with unread results.',
          })}
          checked={rules.includeCompletedReview}
          onChange={(checked) => updateRules({ includeCompletedReview: checked })}
        />
        <RuleSwitch
          label={t('workbench.rules.stalled', {
            defaultValue: 'No-progress detection',
          })}
          description={t('workbench.rules.stalledHint', {
            defaultValue:
              'Disabled by default. Exclude dev servers and watchers after enabling it.',
          })}
          checked={rules.stalledEnabled}
          onChange={(checked) => updateRules({ stalledEnabled: checked })}
        />
      </div>

      {rules.stalledEnabled && (
        <>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-foreground">
              {t('workbench.rules.threshold', {
                defaultValue: 'No-progress threshold',
              })}
            </span>
            <select
              value={rules.stalledThresholdMinutes}
              onChange={(event) =>
                updateRules({ stalledThresholdMinutes: Number(event.target.value) })
              }
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-primary"
            >
              {[15, 30, 60, 120, 240].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {t('workbench.rules.minutes', {
                    count: minutes,
                    defaultValue: '{{count}} minutes',
                  })}
                </option>
              ))}
            </select>
          </label>

          {cards.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-foreground">
                {t('workbench.rules.exclusions', {
                  defaultValue: 'Exclude long-running sessions',
                })}
              </div>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {cards.map((card) => {
                  const excluded = rules.stalledExcludedCardIds.includes(card.id);
                  return (
                    <label
                      key={card.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        checked={excluded}
                        onChange={() => toggleStalledExclusion(card.id)}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium">
                          {card.projectName}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {card.branchLabel ?? card.terminalType}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <div className="rounded-md border border-border px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {t('workbench.rules.retryNote', {
          defaultValue:
            'Automatic restart limits remain card-specific. This workbench does not create a second retry policy.',
        })}
      </div>

      <button
        type="button"
        onClick={resetRules}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <RotateCcw className="h-3 w-3" />
        {t('workbench.rules.reset', { defaultValue: 'Reset rules' })}
      </button>
    </div>
  );
}

function RuleSwitch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-medium text-foreground">{label}</span>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={[
          'relative h-4 w-7 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5',
          ].join(' ')}
        />
      </span>
    </button>
  );
}
