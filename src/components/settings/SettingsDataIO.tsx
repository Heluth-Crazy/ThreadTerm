import { useRef, useState } from 'react';
import { Download, FileJson, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { emitSettingsChanged } from '../../lib/settingsSync';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  buildSettingsBundleDiff,
  createSettingsBundle,
  getDefaultSelectedSettingsSections,
  getSettingsBundleExportFilename,
  normalizeBundleCustomThemePacks,
  parseSettingsBundle,
  stringifySettingsBundle,
  type SettingsBundle,
  type SettingsBundleSectionDiff,
  type SettingsBundleSectionId,
} from '../../lib/settings/settingsBundle';
import type { ThemePack } from '../../theme/themeTypes';
import { SettingsSection } from './SettingsSection';

type StatusState = {
  kind: 'success' | 'error';
  message: string;
} | null;

interface PendingImport {
  bundle: SettingsBundle;
  diffs: SettingsBundleSectionDiff[];
}

const SECTION_DEFAULT_LABELS: Record<SettingsBundleSectionId, string> = {
  theme: 'Theme preference',
  customThemes: 'Custom themes',
  terminal: 'Terminal preferences',
  overlay: 'Overlay hotkeys',
};

const STATUS_DEFAULT_LABELS = {
  added: 'New',
  changed: 'Changed',
  unchanged: 'Unchanged',
} as const;

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function SettingsDataIO() {
  const { t } = useTranslation('settings');
  const {
    themeMode,
    themePackId,
    themePacks,
    setThemePreference,
    replaceCustomThemePacks,
  } = useTheme();
  const osNotificationsEnabled = useTerminalStore((s) => s.osNotificationsEnabled);
  const osNotificationPreviewEnabled = useTerminalStore((s) => s.osNotificationPreviewEnabled);
  const agentCliCompatibilityCompletionEnabled = useTerminalStore(
    (s) => s.agentCliCompatibilityCompletionEnabled,
  );
  const selectorMode = useOverlayStore((s) => s.selectorMode);
  const setSelectorMode = useOverlayStore((s) => s.setSelectorMode);
  const hotkeyA = useOverlayStore((s) => s.hotkeyA);
  const hotkeyB = useOverlayStore((s) => s.hotkeyB);
  const lightweightMode = useOverlayStore((s) => s.lightweightMode);
  const setLightweightMode = useOverlayStore((s) => s.setLightweightMode);
  const updateHotkey = useOverlayStore((s) => s.updateHotkey);

  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<StatusState>(null);
  const [exporting, setExporting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [selectedSections, setSelectedSections] = useState<SettingsBundleSectionId[]>([]);

  const buildCurrentBundle = async () =>
    createSettingsBundle({
      themePreference: { themeMode, themePackId },
      customThemePacks: (themePacks as ThemePack[]).filter((pack) => pack.isCustom),
      terminalSettings: {
        osNotificationsEnabled,
        osNotificationPreviewEnabled,
        agentCliCompatibilityCompletionEnabled,
      },
      overlaySettings: { selectorMode, hotkeyA, hotkeyB, lightweightMode },
    });

  const handleExport = async () => {
    setExporting(true);
    setStatus(null);
    try {
      const bundle = await buildCurrentBundle();
      downloadTextFile(getSettingsBundleExportFilename(), stringifySettingsBundle(bundle));
      setStatus({
        kind: 'success',
        message: t('dataIO.status.exported', {
          defaultValue: 'Settings JSON exported.',
        }),
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: t('dataIO.status.exportFailed', {
          message: error instanceof Error ? error.message : String(error),
          defaultValue: 'Settings export failed: {{message}}',
        }),
      });
    } finally {
      setExporting(false);
    }
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus(null);
    setPendingImport(null);
    try {
      const parsed = parseSettingsBundle(await file.text());
      if (parsed.kind === 'error') {
        throw new Error(parsed.message);
      }
      const current = await buildCurrentBundle();
      const diffs = buildSettingsBundleDiff(current, parsed.bundle);
      setPendingImport({ bundle: parsed.bundle, diffs });
      setSelectedSections(getDefaultSelectedSettingsSections(diffs));
      setStatus({
        kind: 'success',
        message: t('dataIO.status.importReady', {
          defaultValue: 'Settings import preview is ready.',
        }),
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: t('dataIO.status.importFailed', {
          message: error instanceof Error ? error.message : String(error),
          defaultValue: 'Settings import failed: {{message}}',
        }),
      });
    } finally {
      event.target.value = '';
    }
  };

  const toggleSection = (id: SettingsBundleSectionId) => {
    setSelectedSections((current) =>
      current.includes(id)
        ? current.filter((sectionId) => sectionId !== id)
        : [...current, id],
    );
  };

  const handleApplyImport = async () => {
    if (!pendingImport || selectedSections.length === 0) return;

    setApplying(true);
    setStatus(null);
    const selected = new Set(selectedSections);
    const { sections } = pendingImport.bundle;

    try {
      if (selected.has('customThemes') && sections.customThemes) {
        replaceCustomThemePacks(normalizeBundleCustomThemePacks(sections.customThemes.packs));
      }
      if (selected.has('theme') && sections.theme) {
        setThemePreference(sections.theme);
      }
      if (selected.has('terminal') && sections.terminal) {
        const terminalPreferences = {
          osNotificationsEnabled: sections.terminal.osNotificationsEnabled,
          osNotificationPreviewEnabled: sections.terminal.osNotificationPreviewEnabled,
          agentCliCompatibilityCompletionEnabled:
            sections.terminal.agentCliCompatibilityCompletionEnabled,
          supervisorEnabled: useTerminalStore.getState().supervisorEnabled,
        };
        useTerminalStore.setState({
          osNotificationsEnabled: terminalPreferences.osNotificationsEnabled,
          osNotificationPreviewEnabled: terminalPreferences.osNotificationPreviewEnabled,
          agentCliCompatibilityCompletionEnabled:
            terminalPreferences.agentCliCompatibilityCompletionEnabled,
        });
        void emitSettingsChanged({
          domain: 'terminal-preferences',
          sourceWindow: 'settings',
          terminalPreferences,
        });
      }
      if (selected.has('overlay') && sections.overlay) {
        await setLightweightMode(sections.overlay.lightweightMode);
        setSelectorMode(sections.overlay.selectorMode);
        await updateHotkey('A', sections.overlay.hotkeyA);
        await updateHotkey('B', sections.overlay.hotkeyB);
      }
      setPendingImport(null);
      setSelectedSections([]);
      setStatus({
        kind: 'success',
        message: t('dataIO.status.importApplied', {
          defaultValue: 'Selected settings were imported.',
        }),
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: t('dataIO.status.applyFailed', {
          message: error instanceof Error ? error.message : String(error),
          defaultValue: 'Could not apply settings import: {{message}}',
        }),
      });
    } finally {
      setApplying(false);
    }
  };

  const selectedSet = new Set(selectedSections);

  return (
    <SettingsSection>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileJson className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">
              {t('dataIO.title', { defaultValue: 'Settings import and export' })}
            </h3>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {t('dataIO.description', {
              defaultValue:
                'Move ThreadTerm preferences, custom themes, and overlay hotkeys with one safe JSON file.',
            })}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <input
            ref={importInputRef}
            data-testid="settings-bundle-file-input"
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportFileChange}
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
          >
            <Upload className="h-3.5 w-3.5" />
            {t('dataIO.importJson', { defaultValue: 'Import settings JSON' })}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting
              ? t('dataIO.exporting', { defaultValue: 'Exporting...' })
              : t('dataIO.exportJson', { defaultValue: 'Export settings JSON' })}
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {t('dataIO.safetyHint', {
          defaultValue:
            'Bridge tokens, paired devices, audit logs, provider keys, cards, and terminal output are never exported.',
        })}
      </p>

      {status && (
        <div
          className={[
            'mt-3 rounded-md border px-3 py-2 text-xs',
            status.kind === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-primary/30 bg-primary/10 text-foreground',
          ].join(' ')}
        >
          {status.message}
        </div>
      )}

      {pendingImport && (
        <div className="mt-4 rounded-lg border border-border bg-background/70 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">
                {t('dataIO.previewTitle', { defaultValue: 'Import preview' })}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('dataIO.previewDescription', {
                  defaultValue: 'Choose which sections should overwrite your current setup.',
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setPendingImport(null);
                setSelectedSections([]);
              }}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t('dataIO.clearPreview', { defaultValue: 'Clear preview' })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-3 divide-y divide-border/50 overflow-hidden rounded-md border border-border">
            {pendingImport.diffs.map((diff) => (
              <label
                key={diff.id}
                className="grid gap-3 bg-card/80 backdrop-blur-md p-3 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
              >
                <span className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(diff.id)}
                    onChange={() => toggleSection(diff.id)}
                    className="mt-0.5 h-4 w-4 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">
                      {t(`dataIO.sections.${diff.id}`, {
                        defaultValue: SECTION_DEFAULT_LABELS[diff.id],
                      })}
                    </span>
                    <span className="mt-1 inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {t(`dataIO.statusLabels.${diff.status}`, {
                        defaultValue: STATUS_DEFAULT_LABELS[diff.status],
                      })}
                    </span>
                  </span>
                </span>

                <span className="grid min-w-0 gap-2 text-xs md:grid-cols-2">
                  <span className="min-w-0 rounded-md bg-background/80 p-2">
                    <span className="block font-medium text-muted-foreground">
                      {t('dataIO.current', { defaultValue: 'Current' })}
                    </span>
                    <span className="mt-1 block break-words text-foreground">
                      {diff.currentSummary}
                    </span>
                  </span>
                  <span className="min-w-0 rounded-md bg-background/80 p-2">
                    <span className="block font-medium text-muted-foreground">
                      {t('dataIO.incoming', { defaultValue: 'Import' })}
                    </span>
                    <span className="mt-1 block break-words text-foreground">
                      {diff.incomingSummary}
                    </span>
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleApplyImport}
              disabled={applying || selectedSections.length === 0}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applying
                ? t('dataIO.applying', { defaultValue: 'Applying...' })
                : t('dataIO.applyImport', { defaultValue: 'Apply selected' })}
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
