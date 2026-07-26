import type { ChangeEvent, MouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  FileJson,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  Settings as SettingsIcon,
  ShieldAlert,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../theme/ThemeContext';
import { confirmDialog } from '../../lib/nativeDialog';
import LanguageSelector from './LanguageSelector';
import KeyboardShortcutsSettings from './KeyboardShortcutsSettings';
import { NotificationSettings } from './NotificationSettings';
import { NotificationPreferenceSettings } from './NotificationPreferenceSettings';
import OverlayHotkeysSettings from './OverlayHotkeysSettings';
import { SettingsDataIO } from './SettingsDataIO';
import { SupervisorSettings } from './SupervisorSettings';
import { SettingsSection } from './SettingsSection';
import type { ThemeMode, ThemePack } from '../../theme/themeTypes';

const TABS = ['appearance', 'shortcuts', 'supervisor', 'data'] as const;
type SettingsTab = (typeof TABS)[number];

interface SettingsProps {
  isOpen: boolean;
  onClose?: () => void;
  initialTab?: SettingsTab;
  embedded?: boolean;
}

type ThemeImportStatus = {
  type: 'success' | 'error';
  message: string;
};

function Settings({
  isOpen,
  onClose = () => {},
  initialTab = 'shortcuts',
  embedded = false,
}: SettingsProps) {
  const {
    themeMode,
    themePackId,
    resolvedMode,
    themePacks,
    setThemeMode,
    setThemePackId,
    importCustomThemePack,
    deleteCustomThemePack,
    exportThemePack,
  } = useTheme();
  const { t } = useTranslation('settings');
  const normalizeTab = (tab: unknown): SettingsTab =>
    TABS.includes(tab as SettingsTab) ? (tab as SettingsTab) : 'shortcuts';
  const [activeTab, setActiveTab] = useState(normalizeTab(initialTab));
  const [themeImportStatus, setThemeImportStatus] = useState<ThemeImportStatus | null>(null);
  const themeFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen || embedded) {
      setActiveTab(normalizeTab(initialTab));
    }
  }, [embedded, isOpen, initialTab]);

  if (!isOpen && !embedded) {
    return null;
  }

  const containerClassName = embedded
    ? 'h-full overflow-y-auto bg-background'
    : 'modal-backdrop fixed inset-0 z-modal flex items-center justify-center bg-background/40 backdrop-blur-md p-4';
  const panelClassName = embedded
    ? 'mx-auto flex h-full w-full max-w-5xl flex-col bg-background'
    : 'flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background/80 backdrop-blur-2xl shadow-studio glass-reflection md:h-[86vh]';
  const contentPadding = embedded ? 'px-4 py-4 sm:px-6 lg:px-8' : 'p-4 md:p-6';

  const tabButtonClassName = (tab: SettingsTab) => [
    'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    activeTab === tab
      ? 'bg-background text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground',
  ].join(' ');

  const modeOptions: Array<{ id: ThemeMode; icon: typeof Monitor }> = [
    { id: 'system', icon: Monitor },
    { id: 'light', icon: Sun },
    { id: 'dark', icon: Moon },
  ];

  const downloadThemePack = (packId: string) => {
    const { filename, content } = exportThemePack(packId);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setThemeImportStatus({
      type: 'success',
      message: t('appearanceSettings.themePack.exportSuccess'),
    });
  };

  const handleThemeFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      const pack = importCustomThemePack(content);
      setThemeImportStatus({
        type: 'success',
        message: t('appearanceSettings.themePack.importSuccess', { name: pack.name }),
      });
    } catch (error) {
      setThemeImportStatus({
        type: 'error',
        message: t('appearanceSettings.themePack.importFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      event.target.value = '';
    }
  };

  const handleDeleteCustomTheme = async (
    event: MouseEvent<HTMLButtonElement>,
    pack: ThemePack,
  ) => {
    event.stopPropagation();
    const confirmed = await confirmDialog(
      t('appearanceSettings.themePack.deleteConfirm', { name: pack.name }),
      {
        title: t('appearanceSettings.themePack.deleteTitle', {
          defaultValue: 'Delete theme',
        }),
        kind: 'warning',
      },
    );
    if (!confirmed) {
      return;
    }
    deleteCustomThemePack(pack.id);
    setThemeImportStatus({
      type: 'success',
      message: t('appearanceSettings.themePack.deleteSuccess', { name: pack.name }),
    });
  };

  return (
    <div className={containerClassName}>
      <div className={panelClassName}>
        <div className="flex shrink-0 items-center justify-between border-b border-border p-4 md:p-6 backdrop-blur-md bg-card/80">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-foreground">
              <SettingsIcon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                ThreadTerm
              </p>
              <h2 className="mt-1 text-lg font-semibold text-foreground md:text-xl">
                {t('title')}
              </h2>
            </div>
          </div>
          {!embedded && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('close', 'Close settings')}
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="border-b border-border px-4 py-2 md:px-6 backdrop-blur-sm bg-card/80 overflow-x-auto no-scrollbar">
          <div className="inline-flex min-w-full sm:min-w-0 rounded-lg border border-border bg-muted/50 p-1">
            <button
              type="button"
              onClick={() => setActiveTab('appearance')}
              className={tabButtonClassName('appearance')}
            >
              <Palette className="h-4 w-4" />
              {t('mainTabs.appearance')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('shortcuts')}
              className={tabButtonClassName('shortcuts')}
            >
              <Keyboard className="h-4 w-4" />
              {t('mainTabs.shortcuts', 'Shortcuts')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('supervisor')}
              className={tabButtonClassName('supervisor')}
            >
              <ShieldAlert className="h-4 w-4" />
              {t('mainTabs.supervisor', 'Supervisor')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('data')}
              className={tabButtonClassName('data')}
            >
              <FileJson className="h-4 w-4" />
              {t('mainTabs.data', 'Data')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={contentPadding}>
            {activeTab === 'appearance' && (
              <div className="space-y-5">
                <SettingsSection>
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="font-medium text-foreground">
                        {t('appearanceSettings.mode.label')}
                      </div>
                      <div className="text-sm leading-5 text-muted-foreground">
                        {t('appearanceSettings.mode.description')}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-muted/50 p-1">
                      {modeOptions.map(({ id, icon: Icon }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setThemeMode(id)}
                          className={[
                            'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                            themeMode === id
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground',
                          ].join(' ')}
                          aria-pressed={themeMode === id}
                        >
                          <Icon className="h-4 w-4" />
                          {t(`appearanceSettings.mode.options.${id}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                </SettingsSection>

                <SettingsSection>
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:justify-between">
                    <div>
                      <div className="font-medium text-foreground">
                        {t('appearanceSettings.themePack.label')}
                      </div>
                      <div className="text-sm leading-5 text-muted-foreground">
                        {t('appearanceSettings.themePack.description')}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        ref={themeFileInputRef}
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={handleThemeFileChange}
                      />
                      <button
                        type="button"
                        onClick={() => themeFileInputRef.current?.click()}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
                      >
                        <Upload className="h-4 w-4" />
                        {t('appearanceSettings.themePack.importJson')}
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadThemePack(themePackId)}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
                      >
                        <Download className="h-4 w-4" />
                        {t('appearanceSettings.themePack.exportCurrent')}
                      </button>
                    </div>
                    {themeImportStatus && (
                      <div
                        className={[
                          'basis-full rounded-lg border px-3 py-2 text-sm',
                          themeImportStatus.type === 'error'
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : 'border-primary/30 bg-primary/10 text-foreground',
                        ].join(' ')}
                      >
                        {themeImportStatus.message}
                      </div>
                    )}
                  </div>

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {themePacks.map((pack) => {
                      const previewMode = pack.modes[resolvedMode]
                        ? resolvedMode
                        : pack.modes.dark
                          ? 'dark'
                          : 'light';
                      const tokens = pack.modes[previewMode];
                      if (!tokens) {
                        return null;
                      }
                      const isActive = themePackId === pack.id;
                      const attributionLabel =
                        pack.attribution.kind === 'original'
                          ? t('appearanceSettings.themePack.original')
                          : pack.attribution.kind === 'based-on'
                            ? t('appearanceSettings.themePack.basedOn', {
                                source: pack.attribution.sourceName,
                              })
                            : t('appearanceSettings.themePack.inspiredBy', {
                                source: pack.attribution.sourceName,
                              });

                      return (
                        <div
                          key={pack.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => setThemePackId(pack.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setThemePackId(pack.id);
                            }
                          }}
                          className={[
                            'group flex h-full min-h-[320px] flex-col rounded-lg border p-3 text-left transition-all',
                            isActive
                              ? 'border-primary/50 bg-primary/5 shadow-[0_0_20px_hsl(var(--primary)/0.1)] ring-1 ring-primary/20'
                              : 'border-border bg-card/80 hover:border-primary/40 hover:bg-accent',
                          ].join(' ')}
                          aria-pressed={isActive}
                        >
                          <div className="flex min-h-[76px] items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="min-w-0 truncate text-sm font-semibold text-foreground">{pack.name}</span>
                                {!pack.modes.light && (
                                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                    {t('appearanceSettings.themePack.darkOnly')}
                                  </span>
                                )}
                                {pack.isCustom && (
                                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-primary">
                                    {t('appearanceSettings.themePack.custom')}
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                {pack.isCustom
                                  ? pack.description
                                  : t(`appearanceSettings.themePack.descriptions.${pack.id}`, pack.description)}
                              </p>
                            </div>
                            <span
                              className={[
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                                isActive
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-border bg-card/80 backdrop-blur-md text-transparent',
                              ].join(' ')}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </span>
                          </div>

                          <div className="mt-auto overflow-hidden rounded-lg border border-border">
                            <div
                              className="flex h-12 items-center gap-2 px-3"
                              style={{ backgroundColor: tokens.app.background, color: tokens.app.foreground }}
                            >
                              <span
                                className="h-6 w-10 rounded-md border"
                                style={{
                                  backgroundColor: tokens.app.card,
                                  borderColor: tokens.app.border,
                                }}
                              />
                              <span
                                className="h-6 w-6 rounded-full"
                                style={{ backgroundColor: tokens.app.primary }}
                              />
                              <span
                                className="h-6 w-6 rounded-full"
                                style={{ backgroundColor: tokens.app.accent }}
                              />
                              <span className="ml-auto text-[11px] font-medium opacity-80">
                                {previewMode === 'dark'
                                  ? t('appearanceSettings.mode.options.dark')
                                  : t('appearanceSettings.mode.options.light')}
                              </span>
                            </div>
                            <div
                              className="flex h-9 items-center gap-1.5 px-3"
                              style={{
                                backgroundColor: tokens.terminal.background,
                                color: tokens.terminal.foreground,
                              }}
                            >
                              {[
                                tokens.terminal.red,
                                tokens.terminal.green,
                                tokens.terminal.yellow,
                                tokens.terminal.blue,
                                tokens.terminal.magenta,
                                tokens.terminal.cyan,
                              ].map((color) => (
                                <span
                                  key={color}
                                  className="h-3 w-3 rounded-full"
                                  style={{ backgroundColor: color }}
                                />
                              ))}
                              <span className="ml-auto font-mono text-[11px] opacity-80">xterm</span>
                            </div>
                          </div>

                          <span className="mt-3 flex min-h-[32px] items-start gap-1 text-[11px] leading-4 text-muted-foreground">
                            {attributionLabel}
                            {pack.attribution.kind !== 'original' && (
                              <a
                                href={pack.attribution.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                className="inline-flex items-center gap-0.5 text-primary hover:underline"
                              >
                                {t('appearanceSettings.themePack.source')}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </span>

                          {pack.isCustom && (
                            <button
                              type="button"
                              onClick={(event) => handleDeleteCustomTheme(event, pack)}
                              className="mt-2 inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="h-3 w-3" />
                              {t('appearanceSettings.themePack.delete')}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </SettingsSection>

                <LanguageSelector />
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="space-y-6">
                <NotificationSettings />
                <NotificationPreferenceSettings />
                <OverlayHotkeysSettings />
                <KeyboardShortcutsSettings />
              </div>
            )}

            {activeTab === 'supervisor' && (
              <div className="space-y-6">
                <SupervisorSettings />
              </div>
            )}

            {activeTab === 'data' && (
              <div className="space-y-6">
                <SettingsDataIO />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
