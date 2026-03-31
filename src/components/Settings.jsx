import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { X, Settings as SettingsIcon, Moon, Sun, GitBranch } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import GitSettings from './GitSettings';
import AgentListItem from './settings/AgentListItem';
import PermissionsContent from './settings/PermissionsContent';
import LanguageSelector from './LanguageSelector';
import {
  normalizeSessionLaunchProfiles,
  resolveDefaultSessionLaunchProfileId,
} from '../utils/sessionLaunchProfiles';
import {
  FILE_ACCESS_MODE_STORAGE_KEY,
  FILE_ACCESS_MODES,
  getStoredFileAccessMode,
} from '../utils/fileAccessMode';

function Settings({ isOpen, onClose = () => {}, initialTab = 'agents', embedded = false }) {
  const { isDarkMode, toggleDarkMode } = useTheme();
  const { t } = useTranslation('settings');
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);
  const [projectSortOrder, setProjectSortOrder] = useState('name');
  const [fileAccessMode, setFileAccessMode] = useState(FILE_ACCESS_MODES.AUTO);

  const normalizeTab = (tab) => (['agents', 'appearance', 'git'].includes(tab) ? tab : 'agents');
  const tabButtonClassName = (tab) => cn(
    'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    activeTab === tab
      ? 'bg-background text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground',
  );
  const [activeTab, setActiveTab] = useState(normalizeTab(initialTab));
  const [selectedAgent, setSelectedAgent] = useState('claude');

  const [claudeSessionLaunchProfiles, setClaudeSessionLaunchProfiles] = useState(() =>
    normalizeSessionLaunchProfiles([], 'claude')
  );
  const [claudeDefaultSessionLaunchProfileId, setClaudeDefaultSessionLaunchProfileId] = useState(() => {
    const defaults = normalizeSessionLaunchProfiles([], 'claude');
    return defaults[0]?.id || '';
  });
  const [codexSessionLaunchProfiles, setCodexSessionLaunchProfiles] = useState(() =>
    normalizeSessionLaunchProfiles([], 'codex')
  );
  const [codexDefaultSessionLaunchProfileId, setCodexDefaultSessionLaunchProfileId] = useState(() => {
    const defaults = normalizeSessionLaunchProfiles([], 'codex');
    return defaults[0]?.id || '';
  });

  useEffect(() => {
    if (isOpen || embedded) {
      loadSettings();
      setActiveTab(normalizeTab(initialTab));
    }
  }, [embedded, isOpen, initialTab]);


  const loadSettings = async () => {
    try {
      const savedSettings = localStorage.getItem('claude-settings');
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        setProjectSortOrder(settings.projectSortOrder || 'name');

        const claudeProfiles = normalizeSessionLaunchProfiles(settings.sessionLaunchProfiles, 'claude');
        setClaudeSessionLaunchProfiles(claudeProfiles);
        setClaudeDefaultSessionLaunchProfileId(
          resolveDefaultSessionLaunchProfileId(settings.defaultSessionLaunchProfileId, claudeProfiles)
        );
      } else {
        const defaultClaudeProfiles = normalizeSessionLaunchProfiles([], 'claude');
        setProjectSortOrder('name');
        setClaudeSessionLaunchProfiles(defaultClaudeProfiles);
        setClaudeDefaultSessionLaunchProfileId(defaultClaudeProfiles[0]?.id || '');
      }

      setFileAccessMode(getStoredFileAccessMode());

      const savedCodexSettings = localStorage.getItem('codex-settings');
      if (savedCodexSettings) {
        const codexSettings = JSON.parse(savedCodexSettings);
        const codexProfiles = normalizeSessionLaunchProfiles(codexSettings.sessionLaunchProfiles, 'codex');
        setCodexSessionLaunchProfiles(codexProfiles);
        setCodexDefaultSessionLaunchProfileId(
          resolveDefaultSessionLaunchProfileId(codexSettings.defaultSessionLaunchProfileId, codexProfiles)
        );
      } else {
        const defaultCodexProfiles = normalizeSessionLaunchProfiles([], 'codex');
        setCodexSessionLaunchProfiles(defaultCodexProfiles);
        setCodexDefaultSessionLaunchProfileId(defaultCodexProfiles[0]?.id || '');
      }
    } catch (error) {
      console.error('Error loading tool settings:', error);
      setProjectSortOrder('name');
      setFileAccessMode(FILE_ACCESS_MODES.AUTO);
      const fallbackClaudeProfiles = normalizeSessionLaunchProfiles([], 'claude');
      const fallbackCodexProfiles = normalizeSessionLaunchProfiles([], 'codex');
      setClaudeSessionLaunchProfiles(fallbackClaudeProfiles);
      setClaudeDefaultSessionLaunchProfileId(fallbackClaudeProfiles[0]?.id || '');
      setCodexSessionLaunchProfiles(fallbackCodexProfiles);
      setCodexDefaultSessionLaunchProfileId(fallbackCodexProfiles[0]?.id || '');
    }
  };

  const saveSettings = () => {
    setIsSaving(true);
    setSaveStatus(null);

    try {
      const normalizedClaudeProfiles = normalizeSessionLaunchProfiles(claudeSessionLaunchProfiles, 'claude');
      const normalizedCodexProfiles = normalizeSessionLaunchProfiles(codexSessionLaunchProfiles, 'codex');

      const claudeSettings = {
        projectSortOrder,
        sessionLaunchProfiles: normalizedClaudeProfiles,
        defaultSessionLaunchProfileId: resolveDefaultSessionLaunchProfileId(
          claudeDefaultSessionLaunchProfileId,
          normalizedClaudeProfiles
        ),
        lastUpdated: new Date().toISOString(),
      };

      const codexSettings = {
        sessionLaunchProfiles: normalizedCodexProfiles,
        defaultSessionLaunchProfileId: resolveDefaultSessionLaunchProfileId(
          codexDefaultSessionLaunchProfileId,
          normalizedCodexProfiles
        ),
        lastUpdated: new Date().toISOString(),
      };

      localStorage.setItem('claude-settings', JSON.stringify(claudeSettings));
      localStorage.setItem('codex-settings', JSON.stringify(codexSettings));
      localStorage.setItem(FILE_ACCESS_MODE_STORAGE_KEY, fileAccessMode);

      setSaveStatus('success');
      if (!embedded) {
        setTimeout(() => {
          onClose();
        }, 1000);
      }
    } catch (error) {
      console.error('Error saving tool settings:', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen && !embedded) {
    return null;
  }

  const containerClassName = embedded
    ? 'h-full overflow-y-auto bg-background'
    : 'modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 md:p-4';
  const panelClassName = embedded
    ? 'mx-auto flex h-full w-full max-w-6xl flex-col bg-background'
    : 'flex h-full w-full flex-col bg-background border border-border shadow-xl md:max-w-4xl md:h-[90vh] md:rounded-lg';

  return (
    <div className={containerClassName}>
      <div className={panelClassName}>
        <div className={cn(
          'flex flex-shrink-0 items-center justify-between border-b border-border/60',
          embedded ? 'px-4 py-3.5 sm:px-6 lg:px-8' : 'p-4 md:p-6',
        )}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted text-foreground">
              <SettingsIcon className="h-5 w-5" />
            </div>
            <div>
              {embedded ? <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p> : null}
              <h2 className="mt-1 text-lg font-semibold text-foreground md:text-xl">{t('title')}</h2>
            </div>
          </div>
          {!embedded && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-5 h-5" />
            </Button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {!embedded && (
            <div className={cn(
              'border-b border-border/60',
              embedded ? 'px-4 py-3 sm:px-6 lg:px-8' : 'px-4 py-2 md:px-6',
            )}>
              <div className="inline-flex rounded-xl border border-border/70 bg-card/70 p-1">
                <button
                  onClick={() => setActiveTab('agents')}
                  className={tabButtonClassName('agents')}
                >
                  {t('mainTabs.agents')}
                </button>
                <button
                  onClick={() => setActiveTab('appearance')}
                  className={tabButtonClassName('appearance')}
                >
                  {t('mainTabs.appearance')}
                </button>
                <button
                  onClick={() => setActiveTab('git')}
                  className={tabButtonClassName('git')}
                >
                  <GitBranch className="h-4 w-4" />
                  {t('mainTabs.git')}
                </button>
              </div>
            </div>
          )}

          <div className={cn(
            'space-y-4 ',
            embedded ? 'px-4 py-3.5 sm:px-6 lg:px-8' : 'p-4 md:p-6',
          )}>
            {activeTab === 'agents' && (
              <div className="flex min-h-[420px] flex-col overflow-hidden rounded-[24px] border border-border/60 bg-card/72 shadow-sm md:min-h-[500px] md:flex-row">
                <div className="w-56 flex-shrink-0 border-r border-border/60 bg-card/30">
                  <div className="space-y-1.5 p-3">
                    <AgentListItem
                      agentId="claude"
                      isSelected={selectedAgent === 'claude'}
                      onClick={() => setSelectedAgent('claude')}
                    />
                    <AgentListItem
                      agentId="codex"
                      isSelected={selectedAgent === 'codex'}
                      onClick={() => setSelectedAgent('codex')}
                    />
                  </div>
                </div>

                <div className="flex flex-1 flex-col overflow-hidden bg-background">
                  <div className="flex-1 overflow-y-auto p-3.5 md:p-4">
                    {selectedAgent === 'claude' && (
                      <PermissionsContent
                        agent="claude"
                        launchProfiles={claudeSessionLaunchProfiles}
                        setLaunchProfiles={setClaudeSessionLaunchProfiles}
                        defaultLaunchProfileId={claudeDefaultSessionLaunchProfileId}
                        setDefaultLaunchProfileId={setClaudeDefaultSessionLaunchProfileId}
                      />
                    )}
                    {selectedAgent === 'codex' && (
                      <PermissionsContent
                        agent="codex"
                        launchProfiles={codexSessionLaunchProfiles}
                        setLaunchProfiles={setCodexSessionLaunchProfiles}
                        defaultLaunchProfileId={codexDefaultSessionLaunchProfileId}
                        setDefaultLaunchProfileId={setCodexDefaultSessionLaunchProfileId}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-4">
                <div>
                  <div className="rounded-[20px] border border-border/60 bg-card/72 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="font-medium text-foreground">
                          {t('appearanceSettings.darkMode.label')}
                        </div>
                        <div className="text-sm leading-5 text-muted-foreground">
                          {t('appearanceSettings.darkMode.description')}
                        </div>
                      </div>
                      <button
                        onClick={toggleDarkMode}
                        className="relative inline-flex h-8 w-14 items-center rounded-full bg-muted transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:ring-offset-2"
                        role="switch"
                        aria-checked={isDarkMode}
                        aria-label="Toggle dark mode"
                      >
                        <span className="sr-only">Toggle dark mode</span>
                        <span
                          className={`${
                            isDarkMode ? 'translate-x-7' : 'translate-x-1'
                          } inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform duration-200 flex items-center justify-center`}
                        >
                          {isDarkMode ? (
                            <Moon className="w-3.5 h-3.5 text-gray-700" />
                          ) : (
                            <Sun className="w-3.5 h-3.5 text-yellow-500" />
                          )}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <LanguageSelector />
                </div>

                <div>
                  <div className="rounded-[20px] border border-border/60 bg-card/72 p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium text-foreground">
                          {t('appearanceSettings.projectSorting.label')}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {t('appearanceSettings.projectSorting.description')}
                        </div>
                      </div>
                      <select
                        value={projectSortOrder}
                        onChange={(e) => setProjectSortOrder(e.target.value)}
                        className="h-10 w-36 rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
                      >
                        <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
                        <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="rounded-[20px] border border-border/60 bg-card/72 p-4 shadow-sm">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2">
                        <div className="font-medium text-foreground">
                          {t('appearanceSettings.fileAccessMode.label')}
                        </div>
                        <div className="max-w-2xl text-sm leading-5 text-muted-foreground">
                          {t('appearanceSettings.fileAccessMode.description')}
                        </div>
                        <div className="space-y-1 text-xs leading-5 text-muted-foreground/90">
                          <div>{t('appearanceSettings.fileAccessMode.autoHelp')}</div>
                          <div>{t('appearanceSettings.fileAccessMode.compatibilityHelp')}</div>
                          <div>{t('appearanceSettings.fileAccessMode.directHelp')}</div>
                        </div>
                      </div>
                      <select
                        value={fileAccessMode}
                        onChange={(e) => setFileAccessMode(e.target.value)}
                        className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40 lg:w-52"
                      >
                        <option value={FILE_ACCESS_MODES.AUTO}>{t('appearanceSettings.fileAccessMode.auto')}</option>
                        <option value={FILE_ACCESS_MODES.TERMINAL_FIRST}>{t('appearanceSettings.fileAccessMode.compatibility')}</option>
                        <option value={FILE_ACCESS_MODES.DIRECT}>{t('appearanceSettings.fileAccessMode.direct')}</option>
                      </select>
                    </div>
                  </div>
                </div>

              </div>
            )}

            {activeTab === 'git' && <GitSettings />}

          </div>
        </div>

        <div className={cn(
          'flex flex-shrink-0 flex-col gap-3 border-t border-border/60  sm:flex-row sm:items-center sm:justify-between',
          embedded ? 'px-4 py-3.5 sm:px-6 lg:px-8' : 'p-4 md:p-6',
        )}>
          <div className="order-2 flex items-center justify-center gap-2 sm:order-1 sm:justify-start">
            {saveStatus === 'success' && (
              <div className="inline-flex items-center gap-2 rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1.5 text-sm text-green-700 dark:text-green-300">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {t('saveStatus.success')}
              </div>
            )}
            {saveStatus === 'error' && (
              <div className="inline-flex items-center gap-2 rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-sm text-red-700 dark:text-red-300">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {t('saveStatus.error')}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 order-1 sm:order-2">
            {!embedded && (
              <Button
                variant="outline"
                onClick={onClose}
                disabled={isSaving}
                className="h-10 flex-1 rounded-xl sm:flex-none"
              >
                {t('footerActions.cancel')}
              </Button>
            )}
            <Button
              onClick={saveSettings}
              disabled={isSaving}
              className="h-10 flex-1 rounded-xl disabled:opacity-50 sm:flex-none"
            >
              {isSaving ? (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  {t('saveStatus.saving')}
                </div>
              ) : (
                t('footerActions.save')
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
