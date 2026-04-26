import type { TerminalCard } from '../../types/terminal';

export type ProviderSessionProvider = 'claude' | 'codex';
export type ProviderSessionLaunchAction = 'start' | 'resume' | 'discover';

export interface TerminalLaunchCommand {
  command?: string;
  provider?: ProviderSessionProvider;
  providerSessionId?: string;
  action?: ProviderSessionLaunchAction;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

