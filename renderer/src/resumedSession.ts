import type { Session } from '@threadterm/protocol';

function instant(value: string): bigint | undefined {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const fraction = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(3));
}

/** A confirmed resume reply bridges an older snapshot; a newer canonical row always wins. */
export function presentedSession(current: Session, resumed?: Session): Session {
  if (!resumed || current.id !== resumed.id) return current;
  const incoming = instant(current.updatedAt), accepted = instant(resumed.updatedAt);
  if (incoming !== undefined && accepted !== undefined && incoming > accepted) return current;
  if ((current.updatedAt === resumed.updatedAt || (incoming !== undefined && incoming === accepted)) && current.readOnly === resumed.readOnly) return current;
  return resumed;
}
