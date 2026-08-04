import type { TerminalCard } from '../types/terminal';
import {
  isTauriEnv,
  pty,
  type GracefulShutdownProfile,
  type GracefulShutdownResult,
} from './tauri-bridge';

/** Custom commands are opaque, even when the card keeps an Agent icon/type. */
export function gracefulShutdownProfileForCard(
  card: Pick<TerminalCard, 'command' | 'terminalType'>,
): GracefulShutdownProfile {
  if (card.command?.trim()) return 'generic';
  switch (card.terminalType) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'gemini':
    case 'kimi':
    case 'grok':
      return card.terminalType;
    default:
      return 'generic';
  }
}

export function createGracefulShutdownAttemptId(cardId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `shutdown:${cardId}:${suffix}`;
}

export async function requestGracefulTerminalShutdown(
  card: Pick<TerminalCard, 'id' | 'ptyId' | 'command' | 'terminalType'>,
  attemptId: string,
): Promise<GracefulShutdownResult> {
  if (!isTauriEnv()) {
    return {
      attemptId,
      outcome: 'alreadyExited',
      stage: 'shellExit',
    };
  }
  return pty.gracefulShutdown(
    card.ptyId || card.id,
    attemptId,
    gracefulShutdownProfileForCard(card),
  );
}
