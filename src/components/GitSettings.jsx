import { useState, useEffect } from 'react';
import { Check, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../utils/api';
import { Button } from './ui/button';
import { Input } from './ui/input';

function GitSettings() {
  const { t } = useTranslation('settings');
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [gitConfigLoading, setGitConfigLoading] = useState(false);
  const [gitConfigSaving, setGitConfigSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  useEffect(() => {
    loadGitConfig();
  }, []);

  const loadGitConfig = async () => {
    try {
      setGitConfigLoading(true);
      const response = await authenticatedFetch('/api/user/git-config');
      if (response.ok) {
        const data = await response.json();
        setGitName(data.gitName || '');
        setGitEmail(data.gitEmail || '');
      }
    } catch (error) {
      console.error('Error loading git config:', error);
    } finally {
      setGitConfigLoading(false);
    }
  };

  const saveGitConfig = async () => {
    try {
      setGitConfigSaving(true);
      const response = await authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gitName, gitEmail }),
      });

      if (response.ok) {
        setSaveStatus('success');
        setTimeout(() => setSaveStatus(null), 3000);
      } else {
        const data = await response.json();
        setSaveStatus('error');
        console.error('Failed to save git config:', data.error);
      }
    } catch (error) {
      console.error('Error saving git config:', error);
      setSaveStatus('error');
    } finally {
      setGitConfigSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-[24px] border border-border/60 bg-card/72 p-4 shadow-sm">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted text-foreground">
            <GitBranch className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">{t('git.title')}</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{t('git.description')}</p>
          </div>
        </div>

        <div className="space-y-3 rounded-[20px] border border-border/60 bg-background p-4">
          <div>
            <label htmlFor="settings-git-name" className="mb-2 block text-sm font-medium text-foreground">
              {t('git.name.label')}
            </label>
            <Input
              id="settings-git-name"
              type="text"
              value={gitName}
              onChange={(e) => setGitName(e.target.value)}
              placeholder="John Doe"
              disabled={gitConfigLoading}
              className="h-10 w-full rounded-xl"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('git.name.help')}</p>
          </div>

          <div>
            <label htmlFor="settings-git-email" className="mb-2 block text-sm font-medium text-foreground">
              {t('git.email.label')}
            </label>
            <Input
              id="settings-git-email"
              type="email"
              value={gitEmail}
              onChange={(e) => setGitEmail(e.target.value)}
              placeholder="john@example.com"
              disabled={gitConfigLoading}
              className="h-10 w-full rounded-xl"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('git.email.help')}</p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
            {saveStatus === 'success' ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-green-500/20 bg-green-500/10 px-3 py-1.5 text-sm text-green-700 dark:text-green-300">
                <Check className="h-4 w-4" />
                {t('git.status.success')}
              </div>
            ) : <div />}
            <Button
              onClick={saveGitConfig}
              disabled={gitConfigSaving || !gitName || !gitEmail}
              className="h-9 rounded-lg"
            >
              {gitConfigSaving ? t('git.actions.saving') : t('git.actions.save')}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default GitSettings;
