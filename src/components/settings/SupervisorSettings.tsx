/**
 * SupervisorSettings — AI Supervisor v0.1 master switch + telemetry panel.
 *
 * Behaviour (PRD D3, D9, D10, D11):
 *   • `supervisorEnabled` — persisted in terminalStore (v9). Default false.
 *     OFF means the backend never subscribes to events (zero CPU cost).
 *   • Telemetry counters live in the non-persist `supervisorStore`. Reset on
 *     app restart by design (D7) and via the "Reset stats" button (D11).
 *
 * Pure presentation: read store, dispatch store actions, format strings.
 * Business logic (alert ingestion, dedup, regex matching) lives in
 * `src/lib/supervisor/` and `src-tauri/src/supervisor.rs`.
 */
import { useTranslation } from 'react-i18next';
import { Activity, RefreshCw, ShieldAlert } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';

export function SupervisorSettings() {
  const { t } = useTranslation('settings');
  const supervisorEnabled = useTerminalStore((s) => s.supervisorEnabled);
  const setSupervisorEnabled = useTerminalStore((s) => s.setSupervisorEnabled);
  const triggered = useSupervisorStore((s) => s.telemetry.triggered);
  const clicked = useSupervisorStore((s) => s.telemetry.clicked);
  const acted = useSupervisorStore((s) => s.telemetry.acted);
  const resetTelemetry = useSupervisorStore((s) => s.resetTelemetry);

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-md p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-base font-semibold text-foreground">
          {t('supervisorSettings.enableLabel', { defaultValue: 'Enable supervisor' })}
        </h3>
      </div>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">
        {t('supervisorSettings.enableHint', {
          defaultValue: 'Watch pinned cards for prompts that need your attention.',
        })}
      </p>

      {/* Master switch toggle */}
      <div className="mt-4 flex items-center justify-between rounded-xl border border-white/10 bg-background/70 p-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t('supervisorSettings.enableLabel', { defaultValue: 'Enable supervisor' })}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('supervisorSettings.enableHint', {
              defaultValue: 'Watch pinned cards for prompts that need your attention.',
            })}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="supervisor-master-toggle"
            checked={supervisorEnabled}
            onChange={(event) => setSupervisorEnabled(event.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          <span>
            {supervisorEnabled
              ? t('supervisorSettings.statusOn', { defaultValue: 'On' })
              : t('supervisorSettings.statusOff', { defaultValue: 'Off' })}
          </span>
        </label>
      </div>

      {/* How it works */}
      <div className="mt-3 rounded-xl border border-white/10 bg-background/70 p-3">
        <div className="text-sm font-medium text-foreground">
          {t('supervisorSettings.howItWorksTitle', { defaultValue: 'How it works' })}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('supervisorSettings.howItWorksBody', {
            defaultValue:
              'When a pinned card pauses on a sudo prompt, [y/N] confirmation, AI question, or arrow-select menu, ThreadTerm fires a notification. Click it to focus the card and reply in the terminal.',
          })}
        </p>
      </div>

      {/* Telemetry panel (PRD D11) */}
      <div className="mt-3 rounded-xl border border-white/10 bg-background/70 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Activity className="h-4 w-4 text-muted-foreground" />
            {t('supervisorSettings.telemetryTitle', {
              defaultValue: 'Telemetry (this session)',
            })}
          </div>
          <button
            type="button"
            data-testid="supervisor-telemetry-reset"
            onClick={() => resetTelemetry()}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" />
            {t('supervisorSettings.telemetryReset', { defaultValue: 'Reset stats' })}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <TelemetryCard
            testId="supervisor-telemetry-triggered"
            label={t('supervisorSettings.telemetryTriggered', { defaultValue: 'Triggered' })}
            value={triggered}
          />
          <TelemetryCard
            testId="supervisor-telemetry-clicked"
            label={t('supervisorSettings.telemetryClicked', { defaultValue: 'Clicked' })}
            value={clicked}
          />
          <TelemetryCard
            testId="supervisor-telemetry-acted"
            label={t('supervisorSettings.telemetryActed', {
              defaultValue: 'Acted within 60s',
            })}
            value={acted}
          />
        </div>
      </div>
    </section>
  );
}

interface TelemetryCardProps {
  testId: string;
  label: string;
  value: number;
}

function TelemetryCard({ testId, label, value }: TelemetryCardProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-white/10 bg-white/5 backdrop-blur-md/60 p-2 text-center">
      <span className="text-xs leading-tight text-muted-foreground">{label}</span>
      <span
        className="mt-1 text-lg font-semibold text-foreground tabular-nums"
        data-testid={testId}
      >
        {value}
      </span>
    </div>
  );
}
