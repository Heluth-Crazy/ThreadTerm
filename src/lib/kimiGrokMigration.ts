import type { TerminalCard, TerminalType } from '../types/terminal';

/**
 * Conservative recognizer for legacy custom cards that already launch the
 * official Kimi Code or Grok Build CLIs. Only the first executable token is
 * inspected; shell wrappers, pipes, aliases and env prefixes stay custom.
 */
export function recognizeLegacyKimiGrokExecutable(
  command: string | undefined | null,
): 'kimi' | 'grok' | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  // Reject compound / wrapper commands early.
  if (/[|&;<>]/.test(trimmed) || /\n/.test(trimmed)) return null;

  const firstToken = extractFirstToken(trimmed);
  if (!firstToken) return null;

  const basename = firstToken
    .replace(/^['"]|['"]$/g, '')
    .split(/[/\\]/)
    .pop()
    ?.toLowerCase();
  if (!basename) return null;

  if (basename === 'kimi' || basename === 'kimi.exe') return 'kimi';
  if (basename === 'grok' || basename === 'grok.exe') return 'grok';
  return null;
}

function extractFirstToken(command: string): string | null {
  const match = command.match(/^("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/);
  return match?.[1] ?? null;
}

export function migrateLegacyKimiGrokCard<T extends Pick<TerminalCard, 'terminalType' | 'command' | 'providerSessionState'>>(
  card: T,
): T {
  if (card.terminalType !== 'custom') return card;
  const recognized = recognizeLegacyKimiGrokExecutable(card.command);
  if (!recognized) return card;
  return {
    ...card,
    terminalType: recognized as TerminalType,
    providerSessionState: 'unbound',
  };
}

/** Release rollback: map first-class kimi/grok types back to custom. */
export function rollbackKimiGrokTypeToCustom<T extends Pick<TerminalCard, 'terminalType' | 'command'>>(
  card: T,
): T {
  if (card.terminalType !== 'kimi' && card.terminalType !== 'grok') return card;
  return {
    ...card,
    terminalType: 'custom',
  };
}
