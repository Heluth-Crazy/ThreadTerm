import type { TerminalCard, TerminalType } from '../../types/terminal';

export type ProviderSessionProvider = 'claude' | 'codex' | 'opencode' | 'gemini';
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
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-info/30 bg-info/10 text-info',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const AI_CLI_LABELS: Partial<Record<TerminalType, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
};

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isAiCliTerminalType(type: TerminalType): boolean {
  return type === 'claude' || type === 'codex' || type === 'opencode' || type === 'gemini';
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

  if (card.terminalType === 'gemini' || card.terminalType === 'opencode') {
    return {
      labelKey: 'aiSession.cliOnly',
      descriptionKey: 'aiSession.cliOnlyDescription',
      fallbackLabel: 'CLI session',
      fallbackDescription: `${cli} runs as a CLI session; native resume binding is not tracked yet.`,
      tone: 'neutral',
      values: { cli },
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

  if (card.terminalType === 'opencode') {
    if (card.providerSessionId && card.providerSessionState === 'bound') {
      return {
        command: `opencode --session ${shellQuote(card.providerSessionId)}`,
        provider: 'opencode',
        providerSessionId: card.providerSessionId,
        action: 'resume',
      };
    }
    const command = defaultCommand?.trim() || 'opencode';
    return { command };
  }

  if (card.terminalType === 'gemini') {
    if (card.providerSessionId && card.providerSessionState === 'bound') {
      return {
        command: `gemini --resume ${shellQuote(card.providerSessionId)}`,
        provider: 'gemini',
        providerSessionId: card.providerSessionId,
        action: 'resume',
      };
    }
    const command = defaultCommand?.trim() || 'gemini';
    return { command };
  }

  const command = defaultCommand?.trim();
  return command ? { command } : {};
}
