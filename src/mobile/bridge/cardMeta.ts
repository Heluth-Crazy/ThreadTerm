import type { TerminalCard, TerminalStatus } from '../../types/terminal';
import type { CardMeta, TerminalStatus as MobileTerminalStatus } from './protocol';

function toMobileStatus(status: TerminalStatus): MobileTerminalStatus {
  return status === 'waiting' ? 'waiting_for_input' : status;
}

function summaryLineFromCard(card: TerminalCard): string | null {
  const source = card.lastReplyPreview || card.lastOutput;
  const line = source
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return line || null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function cardToMobileMeta(card: TerminalCard): CardMeta {
  return {
    id: card.id,
    ptyId: card.ptyId || card.id,
    status: toMobileStatus(card.status),
    projectPath: card.projectPath,
    projectName: card.projectName,
    worktreePath: card.worktreePath ?? null,
    terminalType: card.terminalType,
    command: card.command ?? null,
    createdAt: card.createdAt,
    lastActivity: card.lastActivity,
    lastReplyPreview: card.lastReplyPreview || card.lastOutput,
    summaryLine: summaryLineFromCard(card),
    hiddenLineCount: 0,
    recentOutputBytes: byteLength(card.lastOutput || card.lastReplyPreview || ''),
    messageCount: card.messageCount,
    unread: card.unread,
    providerSessionState: card.providerSessionState ?? null,
    ptyLive: false,
    ptyState: null,
    attachable: true,
  };
}
