export type Provider = 'claude' | 'codex' | 'cursor';

const COLOR_MAP: Record<string, string> = {
  claude: 'var(--provider-claude)',
  codex: 'var(--provider-codex)',
  cursor: 'var(--provider-cursor)',
};

const BORDER_CLASS_MAP: Record<string, string> = {
  claude: 'border-violet-400/40',
  codex: 'border-blue-400/40',
  cursor: 'border-emerald-400/40',
};

const DOT_CLASS_MAP: Record<string, string> = {
  claude: 'bg-violet-400',
  codex: 'bg-blue-400',
  cursor: 'bg-emerald-400',
};

const BADGE_CLASS_MAP: Record<string, string> = {
  claude: 'bg-violet-400/15 text-violet-600 dark:text-violet-400',
  codex: 'bg-blue-400/15 text-blue-600 dark:text-blue-400',
  cursor: 'bg-emerald-400/15 text-emerald-600 dark:text-emerald-400',
};

export function getProviderColor(provider: Provider | string): string {
  return COLOR_MAP[provider] ?? 'var(--muted-foreground)';
}

export function getProviderBorderClass(provider: string): string {
  return BORDER_CLASS_MAP[provider] ?? '';
}

export function getProviderDotClass(provider: string): string {
  return DOT_CLASS_MAP[provider] ?? 'bg-muted-foreground/40';
}

export function getProviderBadgeClass(provider: string): string {
  return BADGE_CLASS_MAP[provider] ?? '';
}
