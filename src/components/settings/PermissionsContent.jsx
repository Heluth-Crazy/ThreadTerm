import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  normalizeSessionLaunchArgs,
  normalizeSessionLaunchProfiles,
  parseSessionLaunchArgsInput,
  resolveDefaultSessionLaunchProfileId,
} from '../../utils/sessionLaunchProfiles';

const generateLaunchProfileId = (provider) =>
  `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function SessionLaunchProfiles({
  provider,
  profiles,
  defaultProfileId,
  setProfiles,
  setDefaultProfileId,
}) {
  const { t } = useTranslation('settings');
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileArgsInput, setNewProfileArgsInput] = useState('');

  const normalizedProfiles = normalizeSessionLaunchProfiles(profiles, provider);
  const normalizedDefaultId = resolveDefaultSessionLaunchProfileId(defaultProfileId, normalizedProfiles);

  useEffect(() => {
    if (normalizedProfiles !== profiles) {
      setProfiles(normalizedProfiles);
    }
    if (normalizedDefaultId !== defaultProfileId) {
      setDefaultProfileId(normalizedDefaultId);
    }
  }, [defaultProfileId, normalizedDefaultId, normalizedProfiles, profiles, setDefaultProfileId, setProfiles]);

  const addProfile = () => {
    const args = parseSessionLaunchArgsInput(newProfileArgsInput);
    const defaultName = provider === 'codex'
      ? t('permissions.sessionLaunchProfiles.defaultCodexName')
      : t('permissions.sessionLaunchProfiles.defaultClaudeName');
    const displayName = newProfileName.trim() || defaultName;

    setProfiles([
      ...normalizedProfiles,
      {
        id: generateLaunchProfileId(provider),
        name: displayName,
        args,
      },
    ]);
    setNewProfileName('');
    setNewProfileArgsInput('');
  };

  const removeProfile = (profileId) => {
    if (normalizedProfiles.length <= 1) {
      return;
    }

    const nextProfiles = normalizedProfiles.filter((profile) => profile.id !== profileId);
    setProfiles(nextProfiles);

    if (normalizedDefaultId === profileId) {
      setDefaultProfileId(nextProfiles[0]?.id || '');
    }
  };

  const applyClaudeDangerPreset = () => {
    const nextArgs = [...parseSessionLaunchArgsInput(newProfileArgsInput), '--dangerously-skip-permissions'];
    setNewProfileArgsInput(normalizeSessionLaunchArgs(nextArgs).join('\n'));
  };

  return (
    <div className="space-y-4 border border-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">
          {t('permissions.sessionLaunchProfiles.title')}
        </h4>
        <span className="text-xs text-muted-foreground">
          {provider === 'codex' ? 'Codex' : 'Claude'}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('permissions.sessionLaunchProfiles.description')}
      </p>

      <div className="space-y-3">
        {normalizedProfiles.map((profile) => {
          const argsText = normalizeSessionLaunchArgs(profile.args).join(' ');
          return (
            <div key={profile.id} className="border border-border/70 rounded-md p-3 bg-muted/20">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm text-foreground min-w-0">
                  <input
                    type="radio"
                    name={`${provider}-launch-profile-default`}
                    checked={normalizedDefaultId === profile.id}
                    onChange={() => setDefaultProfileId(profile.id)}
                    className="w-4 h-4"
                  />
                  <span className="truncate">{profile.name}</span>
                </label>

                <Button
                  variant="ghost"
                  size="sm"
                  disabled={normalizedProfiles.length <= 1}
                  onClick={() => removeProfile(profile.id)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <code className="text-xs text-muted-foreground break-all mt-2 block">
                {argsText || t('permissions.sessionLaunchProfiles.noArgs')}
              </code>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 pt-1 border-t border-border/60">
        <Input
          value={newProfileName}
          onChange={(event) => setNewProfileName(event.target.value)}
          placeholder={t('permissions.sessionLaunchProfiles.namePlaceholder')}
        />

        <textarea
          value={newProfileArgsInput}
          onChange={(event) => setNewProfileArgsInput(event.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none resize-y focus:ring-2 focus:ring-ring/40"
          placeholder={t('permissions.sessionLaunchProfiles.argsPlaceholder')}
        />

        {provider === 'claude' && (
          <Button variant="outline" size="sm" onClick={applyClaudeDangerPreset}>
            {t('permissions.sessionLaunchProfiles.useDangerPreset')}
          </Button>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={addProfile}>
            <Plus className="w-4 h-4 mr-1" />
            {t('permissions.sessionLaunchProfiles.addProfile')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PermissionsContent({
  agent,
  launchProfiles,
  setLaunchProfiles,
  defaultLaunchProfileId,
  setDefaultLaunchProfileId,
}) {
  const provider = agent === 'codex' ? 'codex' : 'claude';
  return (
    <SessionLaunchProfiles
      provider={provider}
      profiles={launchProfiles}
      defaultProfileId={defaultLaunchProfileId}
      setProfiles={setLaunchProfiles}
      setDefaultProfileId={setDefaultLaunchProfileId}
    />
  );
}
