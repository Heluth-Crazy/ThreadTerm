import type { ServerMessage } from '@shared/mobile/bridge/protocol';

export type TerminalTranscriptMessage = Extract<
  ServerMessage,
  { kind: 'terminal_output' | 'terminal_snapshot' }
>;

const MAX_MESSAGES_PER_CARD = 2000;

export function appendTerminalMessage(
  current: ServerMessage[],
  message: TerminalTranscriptMessage,
): ServerMessage[] {
  const cardId = terminalMessageCardId(message);
  const otherCards = current.filter((item) => terminalMessageCardId(item) !== cardId);
  const sameCard = current.filter((item) => terminalMessageCardId(item) === cardId);

  if (message.kind === 'terminal_snapshot') {
    const snapshotSeq = Number(message.snapshot.seq || 0);
    const retainedOutput = sameCard.filter((item) => {
      if (item.kind !== 'terminal_output') return false;
      return Number(item.seq || 0) > snapshotSeq;
    });
    return [...otherCards, ...trimCardTranscript([message, ...retainedOutput])];
  }

  const latestSnapshot = sameCard.filter((item) => item.kind === 'terminal_snapshot').slice(-1);
  const latestSnapshotSeq =
    latestSnapshot[0]?.kind === 'terminal_snapshot' ? Number(latestSnapshot[0].snapshot.seq || 0) : 0;
  if (latestSnapshotSeq > 0 && Number(message.seq || 0) <= latestSnapshotSeq) {
    return current;
  }

  return [
    ...otherCards,
    ...trimCardTranscript([
      ...latestSnapshot,
      ...sameCard.filter((item) => item.kind === 'terminal_output'),
      message,
    ]),
  ];
}

export function terminalMessageCardId(message: ServerMessage): string | null {
  if (message.kind === 'terminal_output') return message.card_id;
  if (message.kind === 'terminal_snapshot') return message.snapshot.cardId;
  return null;
}

function trimCardTranscript(messages: ServerMessage[]): ServerMessage[] {
  let latestSnapshot: ServerMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].kind === 'terminal_snapshot') {
      latestSnapshot = messages[index];
      break;
    }
  }
  if (latestSnapshot?.kind !== 'terminal_snapshot') {
    return messages.slice(-MAX_MESSAGES_PER_CARD);
  }

  const snapshotSeq = Number(latestSnapshot.snapshot.seq || 0);
  const outputBudget = Math.max(0, MAX_MESSAGES_PER_CARD - 1);
  const retainedOutput = messages
    .filter((item) => item.kind === 'terminal_output' && Number(item.seq || 0) > snapshotSeq)
    .slice(-outputBudget);

  return [latestSnapshot, ...retainedOutput];
}
