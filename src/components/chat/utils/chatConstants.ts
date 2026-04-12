import type { SessionProvider } from '../../../types/app';
import type { ProviderThemeConfig } from '../types/chatTypes';
import { CLAUDE_MODELS, CODEX_MODELS } from '../../../constants/modelConstants.js';

export const MAX_TOOL_RESULT_PREVIEW_CHARS = 3000;

export const MODEL_OPTIONS: Record<SessionProvider, Array<{ value: string; label: string }>> = {
  claude: CLAUDE_MODELS.OPTIONS,
  codex: CODEX_MODELS.OPTIONS,
};

export const MODEL_DEFAULTS: Record<SessionProvider, string> = {
  claude: CLAUDE_MODELS.DEFAULT,
  codex: CODEX_MODELS.DEFAULT,
};

export const PROVIDER_THEME: Record<SessionProvider, ProviderThemeConfig> = {
  claude: {
    panel: 'bg-gradient-to-b from-orange-50/35 via-background to-amber-50/20 dark:from-orange-950/10 dark:via-background dark:to-amber-950/10',
    header: 'bg-orange-50/85 border-orange-200/70 dark:bg-orange-950/25 dark:border-orange-900/50',
    headerTitle: 'text-orange-900 dark:text-orange-100',
    headerIcon: 'text-orange-500',
    brandBadge: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/40 dark:text-orange-100 dark:border-orange-800',
    assistantBubble: 'bg-white border-orange-200 text-zinc-900 shadow-sm dark:bg-zinc-900 dark:border-orange-900/40 dark:text-zinc-100',
    userBubble: 'bg-orange-500 text-white border-orange-500 shadow-sm dark:bg-orange-600 dark:border-orange-600',
    composer: 'bg-white/85 border-orange-200/70 dark:bg-zinc-900/70 dark:border-orange-900/40',
    sendButton: 'bg-orange-500 hover:bg-orange-600 text-white',
    picker: 'border-orange-200/80 dark:border-orange-900/50',
    activePickRow: 'bg-orange-100/70 dark:bg-orange-900/40',
  },
  codex: {
    panel: 'bg-gradient-to-b from-emerald-50/30 via-background to-teal-50/20 dark:from-emerald-950/10 dark:via-background dark:to-teal-950/10',
    header: 'bg-emerald-50/85 border-emerald-200/70 dark:bg-emerald-950/25 dark:border-emerald-900/50',
    headerTitle: 'text-emerald-900 dark:text-emerald-100',
    headerIcon: 'text-emerald-600',
    brandBadge: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100 dark:border-emerald-800',
    assistantBubble: 'bg-white border-emerald-200 text-zinc-900 shadow-sm dark:bg-zinc-900 dark:border-emerald-900/40 dark:text-zinc-100',
    userBubble: 'bg-emerald-600 text-white border-emerald-600 shadow-sm dark:bg-emerald-700 dark:border-emerald-700',
    composer: 'bg-white/85 border-emerald-200/70 dark:bg-zinc-900/70 dark:border-emerald-900/40',
    sendButton: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    picker: 'border-emerald-200/80 dark:border-emerald-900/50',
    activePickRow: 'bg-emerald-100/70 dark:bg-emerald-900/40',
  },
};

export const CHAT_RESPONSE_TYPES = new Set([
  'claude-response',
  'codex-response',
  'claude-complete',
  'codex-complete',
  'claude-error',
  'codex-error',
  'error',
  'token-budget',
  'claude-permission-request',
  'claude-permission-cancelled',
]);

export const THINKING_MESSAGE_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'reasoning',
  'analysis',
  'reasoning_summary',
  'reasoning_content',
]);

export const BYPASS_PERMISSION_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
]);
