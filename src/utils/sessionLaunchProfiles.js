const CLAUDE_SETTINGS_KEY = 'claude-settings';
const CODEX_SETTINGS_KEY = 'codex-settings';

const PROVIDER_KEYS = ['claude', 'codex'];
const DEFAULT_CODEX_ARGS = ['--dangerously-bypass-approvals-and-sandbox'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProfileName(provider, name, index) {
  const fallback = provider === 'claude' ? `Claude Profile ${index + 1}` : `Codex Profile ${index + 1}`;
  const safeName = typeof name === 'string' ? name.trim() : '';
  return safeName || fallback;
}

export function normalizeSessionLaunchArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }

  return args
    .map((arg) => (typeof arg === 'string' ? arg.trim() : ''))
    .filter((arg) => arg.length > 0);
}

export function parseSessionLaunchArgsInput(input) {
  if (typeof input !== 'string') {
    return [];
  }

  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function normalizeSessionLaunchProfiles(rawProfiles, provider) {
  const normalized = [];
  const list = Array.isArray(rawProfiles) ? rawProfiles : [];

  for (let index = 0; index < list.length; index += 1) {
    const profile = list[index];
    if (!isObject(profile)) {
      continue;
    }

    const rawId = typeof profile.id === 'string' ? profile.id.trim() : '';
    const id = rawId || `${provider}-profile-${index + 1}`;
    const name = normalizeProfileName(provider, profile.name, index);
    let args = normalizeSessionLaunchArgs(profile.args);

    // Backward compatibility: old codex-default profiles were created without
    // launch args. Auto-upgrade to the new dangerous-mode default.
    if (provider === 'codex' && id === 'codex-default' && args.length === 0) {
      args = [...DEFAULT_CODEX_ARGS];
    }

    normalized.push({ id, name, args });
  }

  if (normalized.length > 0) {
    return normalized;
  }

  return [
    {
      id: `${provider}-default`,
      name: 'Default',
      args: provider === 'codex' ? [...DEFAULT_CODEX_ARGS] : [],
    },
  ];
}

export function resolveDefaultSessionLaunchProfileId(defaultId, profiles) {
  if (typeof defaultId === 'string' && profiles.some((profile) => profile.id === defaultId)) {
    return defaultId;
  }

  return profiles[0]?.id || '';
}

export function loadSessionLaunchProfilesByProvider(provider) {
  if (!PROVIDER_KEYS.includes(provider)) {
    return {
      profiles: [],
      defaultProfileId: '',
    };
  }

  const settingsKey = provider === 'claude' ? CLAUDE_SETTINGS_KEY : CODEX_SETTINGS_KEY;

  try {
    const raw = localStorage.getItem(settingsKey);
    const parsed = raw ? JSON.parse(raw) : {};
    const profiles = normalizeSessionLaunchProfiles(parsed?.sessionLaunchProfiles, provider);
    const defaultProfileId = resolveDefaultSessionLaunchProfileId(parsed?.defaultSessionLaunchProfileId, profiles);
    return { profiles, defaultProfileId };
  } catch {
    const profiles = normalizeSessionLaunchProfiles([], provider);
    return {
      profiles,
      defaultProfileId: profiles[0]?.id || '',
    };
  }
}

export function mergeSessionLaunchArgs(profiles, profileId, extraArgs) {
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const profileArgs = normalizeSessionLaunchArgs(selectedProfile?.args || []);
  const temporaryArgs = normalizeSessionLaunchArgs(extraArgs);
  return [...profileArgs, ...temporaryArgs];
}
