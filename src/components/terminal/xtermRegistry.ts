/**
 * xtermRegistry — small lookup of the live xterm.js Terminals currently
 * attached to each PTY id.
 *
 * Shell.tsx owns the visible xterm, while other terminal lifecycle code only
 * knows the PTY id. This registry is the narrow lookup used for focus,
 * activation, and cleanup decisions without leaking Shell internals.
 */
import type { Terminal } from '@xterm/xterm';

interface TerminalRegistration {
  term: Terminal;
  registeredAt: number;
  activeAt: number;
}

const terminals = new Map<string, TerminalRegistration[]>();
let registrationSeq = 0;

function nextRegistrationSeq(): number {
  registrationSeq += 1;
  return registrationSeq;
}

function activeRegistration(ptyId: string): TerminalRegistration | undefined {
  const list = terminals.get(ptyId);
  if (!list?.length) return undefined;
  return list.reduce((best, candidate) => {
    if (candidate.activeAt !== best.activeAt) {
      return candidate.activeAt > best.activeAt ? candidate : best;
    }
    return candidate.registeredAt > best.registeredAt ? candidate : best;
  });
}

export function registerTerminal(ptyId: string, term: Terminal): void {
  if (!ptyId) return;
  const list = terminals.get(ptyId) ?? [];
  const activeAt = nextRegistrationSeq();
  const existing = list.find((registration) => registration.term === term);
  if (existing) {
    existing.activeAt = activeAt;
    return;
  }
  list.push({
    term,
    registeredAt: activeAt,
    activeAt,
  });
  terminals.set(ptyId, list);
}

export function unregisterTerminal(ptyId: string, term?: Terminal): void {
  if (!ptyId) return;
  if (!term) {
    terminals.delete(ptyId);
    return;
  }
  const list = terminals.get(ptyId);
  if (!list) return;
  const next = list.filter((registration) => registration.term !== term);
  if (next.length === 0) {
    terminals.delete(ptyId);
    return;
  }
  terminals.set(ptyId, next);
}

export function claimTerminalActive(ptyId: string, term: Terminal): void {
  if (!ptyId) return;
  const list = terminals.get(ptyId);
  const registration = list?.find((candidate) => candidate.term === term);
  if (!registration) {
    registerTerminal(ptyId, term);
    return;
  }
  registration.activeAt = nextRegistrationSeq();
}

/** Return the live Terminal instance for `ptyId`, or `undefined` if not mounted. */
export function getTerminal(ptyId: string): Terminal | undefined {
  return activeRegistration(ptyId)?.term;
}

/** Read-only registry snapshot for memory lifecycle sampling. */
export function getXtermRegistryDiagnostics(): {
  registrationCount: number;
  distinctPtyIds: number;
  ptyIds: string[];
} {
  let registrationCount = 0;
  const ptyIds: string[] = [];
  for (const [ptyId, list] of terminals) {
    registrationCount += list.length;
    ptyIds.push(ptyId);
  }
  return {
    registrationCount,
    distinctPtyIds: ptyIds.length,
    ptyIds,
  };
}
