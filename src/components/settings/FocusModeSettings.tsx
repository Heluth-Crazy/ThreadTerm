/**
 * FocusModeSettings — Stage 6 toggles for the focus-mode bottom chip strip
 * and the default AI Explain provider.
 *
 * Behaviour:
 *   • `bottomBarHidden` — persisted in the terminal store (v7). When true,
 *     the chip strip is omitted from TerminalView. Default false.
 *   • `aiExplainDefaultProvider` — persisted in v7. Used when the focused
 *     card is a shell / npm / etc. card that has no provider of its own.
 */
import { useTranslation } from 'react-i18next';
import { Sparkles, ToggleLeft } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import type { AiExplainProvider } from '../../lib/ai/aiExplain';

const PROVIDERS: AiExplainProvider[] = ['claude', 'codex', 'gemini'];

export function FocusModeSettings() {
  const { t } = useTranslation('settings');
  const bottomBarHidden = useTerminalStore((s) => s.bottomBarHidden);
  const setBottomBarHidden = useTerminalStore((s) => s.setBottomBarHidden);
  const aiExplainDefaultProvider = useTerminalStore((s) => s.aiExplainDefaultProvider);
  const setAiExplainDefaultProvider = useTerminalStore((s) => s.setAiExplainDefaultProvider);

  return (
    <section className="rounded-2xl border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-base font-semibold text-foreground">
          {t('focusMode.title', { defaultValue: 'Focus mode' })}
        </h3>
      </div>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">
        {t('focusMode.description', {
          defaultValue:
            'Configure the focus-mode chip strip and the default AI provider used by "Explain with AI".',
        })}
      </p>

      {/* Chip strip toggle */}
      <div className="mt-4 flex items-center justify-between rounded-xl border border-border/60 bg-background/70 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ToggleLeft className="h-4 w-4 text-muted-foreground" />
            {t('focusMode.chipStripLabel', { defaultValue: 'Show the focus-mode chip strip' })}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('focusMode.chipStripDescription', {
              defaultValue:
                'A row of quick actions (Explain, Copy, Rerun…) pinned to the bottom of the focused terminal.',
            })}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="focus-mode-chip-strip-toggle"
            checked={!bottomBarHidden}
            onChange={(event) => setBottomBarHidden(!event.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          <span>
            {bottomBarHidden
              ? t('focusMode.chipStripOff', { defaultValue: 'Hidden' })
              : t('focusMode.chipStripOn', { defaultValue: 'Visible' })}
          </span>
        </label>
      </div>

      {/* Default provider picker */}
      <div className="mt-3 rounded-xl border border-border/60 bg-background/70 p-3">
        <div className="text-sm font-medium text-foreground">
          {t('focusMode.defaultProviderLabel', { defaultValue: 'Default AI Explain provider' })}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('focusMode.defaultProviderDescription', {
            defaultValue:
              'Used when the focused terminal is not already an AI CLI (e.g. shell, npm, docker).',
          })}
        </p>
        <div
          className="mt-2 inline-flex rounded-xl border border-border/70 bg-muted/50 p-1"
          data-testid="focus-mode-provider-picker"
        >
          {PROVIDERS.map((provider) => {
            const active = aiExplainDefaultProvider === provider;
            return (
              <button
                key={provider}
                type="button"
                data-testid={`focus-mode-provider-${provider}`}
                onClick={() => setAiExplainDefaultProvider(provider)}
                className={[
                  'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}
                aria-pressed={active}
              >
                {provider}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
