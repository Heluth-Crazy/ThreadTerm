import type { ChatRepairAvailability } from '@threadterm/protocol';

export type RepairDiscovery = { sessionId: string; generation: number; phase: 'pending' | 'clear' | 'held' | 'failed'; recovery?: 'legacy' | 'integrity' };

/** Only a visible, offered recovery choice may hold the normal worker connection. */
export function discoveredRepair(sessionId: string, generation: number, repair?: ChatRepairAvailability): RepairDiscovery {
  const held = repair?.offered && (repair.degraded || repair.reason === 'history_metadata_missing');
  return { sessionId, generation, phase: held ? 'held' : 'clear',
    recovery: held ? (repair?.reason === 'history_metadata_missing' ? 'legacy' : 'integrity') : undefined };
}

export function discoveryMatches(discovery: RepairDiscovery | undefined, sessionId: string, generation: number): boolean {
  return discovery?.sessionId === sessionId && discovery.generation === generation;
}
