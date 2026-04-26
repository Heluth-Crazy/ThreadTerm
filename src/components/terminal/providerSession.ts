import type { TerminalCard, TerminalType } from '../../types/terminal';

export type ProviderSessionProvider = 'claude' | 'codex';
export type ProviderSessionLaunchAction = 'start' | 'resume' | 'discover';
export type AiCliSessionBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface TerminalLaunchCommand {
  command?: string;
  provider?: ProviderSessionProvider;
  providerSessionId?: string;
  action?: ProviderSessionLaunchAction;
}

export interface AiCliSessionBadge {
  labelKey: string;
  descriptionKey: string;
  fallbackLabel: string;
  fallbackDescription: string;
  tone: AiCliSessionBadgeTone;
  values?: Record<string, string>;
}

export const AI_CLI_SESSION_BADGE_CLASS: Record<AiCliSessionBadgeTone, string> = {
  neutral: 'border-slate-500/30 bg-slate-500/10 text-slate-500',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-600',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  danger: 'border-red-500/30 bg-red-500/10 text-red-500',
};

const AI_CLI_LABELS: Partial<Record<TerminalType, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isAiCliTerminalType(type: TerminalType): boolean {
  return type === 'claude' || type === 'codex' || type === 'gemini';
}

export function getAiCliName(type: TerminalType): string {
  return AI_CLI_LABELS[type] ?? type;
}

function suffixSessionId(id: string): string {
  return id.length <= 8 ? id : `...${id.slice(-5)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getMissingAiCliName(card: TerminalCard, output = card.lastOutput): string | null {
  if (!isAiCliTerminalType(card.terminalType) || !output) return null;

  const command = card.terminalType;
  const escaped = escapeRegExp(command);
  const patterns = [
    new RegExp(`command not found:\\s*${escaped}\\b`, 'i'),
    new RegExp(`\\b${escaped}(?:\\.exe)?\\s*:\\s*(?:command not found|not found)\\b`, 'i'),
    new RegExp(`\\b${escaped}(?:\\.exe)?\\b.*is not recognized as an internal or external command`, 'i'),
  ];

  return patterns.some((pattern) => pattern.test(output)) ? getAiCliName(card.terminalType) : null;
}

export function getAiCliSessionBadge(card: TerminalCard): AiCliSessionBadge | null {
  if (!isAiCliTerminalType(card.terminalType)) return null;

  const cli = getAiCliName(card.terminalType);
  const missingCli = getMissingAiCliName(card);
  if (missingCli) {
    return {
      labelKey: 'aiSession.missingCli',
      descriptionKey: 'aiSession.missingCliDescription',
      fallbackLabel: `${missingCli} CLI missing`,
      fallbackDescription: `${missingCli} is not installed or is not visible in PATH.`,
      tone: 'danger',
      values: { cli: missingCli },
    };
  }

  if (card.command?.trim()) {
    return {
      labelKey: 'aiSession.customCommand',
      descriptionKey: 'aiSession.customCommandDescription',
      fallbackLabel: 'Custom command',
      fallbackDescription: 'This AI card runs a custom command instead of the default provider command.',
      tone: 'neutral',
      values: { cli },
    };
  }

  if (card.terminalType === 'gemini') {
    return {
      labelKey: 'aiSession.cliOnly',
      descriptionKey: 'aiSession.cliOnlyDescription',
      fallbackLabel: 'CLI session',
      fallbackDescription: `${cli} runs as a CLI session; native resume binding is not tracked yet.`,
      tone: 'neutral',
      values: { cli },
    };
  }

  if (card.providerSessionState === 'bound' && card.providerSessionId) {
    return {
      labelKey: 'aiSession.resumeReady',
      descriptionKey: 'aiSession.resumeReadyDescription',
      fallbackLabel: 'Resume ready',
      fallbackDescription: `${cli} session ${suffixSessionId(card.providerSessionId)} is bound and can be resumed.`,
      tone: 'success',
      values: { cli, id: suffixSessionId(card.providerSessionId) },
    };
  }

  if (card.providerSessionId) {
    return {
      labelKey: 'aiSession.newSession',
      descriptionKey: 'aiSession.newSessionDescription',
      fallbackLabel: 'New session',
      fallbackDescription: `${cli} will start with a ThreadTerm-managed session id.`,
      tone: 'info',
      values: { cli, id: suffixSessionId(card.providerSessionId) },
    };
  }

  return {
    labelKey: 'aiSession.discovery',
    descriptionKey: 'aiSession.discoveryDescription',
    fallbackLabel: 'Session discovery',
    fallbackDescription: `${cli} session id will be discovered after the CLI writes its history.`,
    tone: 'warning',
    values: { cli },
  };
}

export function buildTerminalLaunchCommand(
  card: TerminalCard,
  defaultCommand?: string,
): TerminalLaunchCommand {
  const customCommand = card.command?.trim();
  if (customCommand) return { command: customCommand };

  if (card.terminalType === 'claude') {
    if (card.providerSessionId && card.providerSessionState === 'bound') {
      return {
        command: `claude --resume ${shellQuote(card.providerSessionId)}`,
        provider: 'claude',
        providerSessionId: card.providerSessionId,
        action: 'resume',
      };
    }

    if (card.providerSessionId) {
      return {
        command: `claude --session-id ${shellQuote(card.providerSessionId)}`,
        provider: 'claude',
        providerSessionId: card.providerSessionId,
        action: 'start',
      };
    }

    return {
      command: 'claude',
      provider: 'claude',
      action: 'discover',
    };
  }

  if (card.terminalType === 'codex') {
    if (card.providerSessionId && card.providerSessionState === 'bound') {
      return {
        command: `codex resume ${shellQuote(card.providerSessionId)} --no-alt-screen`,
        provider: 'codex',
        providerSessionId: card.providerSessionId,
        action: 'resume',
      };
    }

    return {
      command: 'codex --no-alt-screen',
      provider: 'codex',
      action: 'discover',
    };
  }

  const command = defaultCommand?.trim();
  return command ? { command } : {};
}
