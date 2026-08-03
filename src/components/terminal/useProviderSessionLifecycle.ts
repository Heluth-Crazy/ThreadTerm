import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauriEnv, providerSessions } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import type { AgentSessionProvider } from '../../types/agentSession';
import type { TerminalCard } from '../../types/terminal';
import type { TerminalLaunchCommand } from './providerSession';

const DISCOVERY_ATTEMPTS = 12;
const DISCOVERY_INTERVAL_MS = 1500;

function collectBoundProviderSessionIds(provider: AgentSessionProvider): string[] {
  const { cards, archivedCards } = useTerminalStore.getState();
  const ids = new Set<string>();
  for (const card of [...cards, ...archivedCards]) {
    if (
      card.terminalType === provider
      && card.providerSessionState === 'bound'
      && card.providerSessionId
    ) {
      ids.add(card.providerSessionId);
    }
  }
  return Array.from(ids);
}

export function useProviderSessionLifecycle(
  card: TerminalCard | null,
  launch: TerminalLaunchCommand | null,
  active = true,
): () => void {
  const markProviderSessionBound = useTerminalStore((s) => s.markProviderSessionBound);
  const discoverySinceRef = useRef<number | null>(null);
  const [discoveryNonce, setDiscoveryNonce] = useState(0);

  const onInitialCommandSent = useCallback(() => {
    if (!card || !launch?.provider) return;

    if (launch.providerSessionId) {
      markProviderSessionBound(card.id, launch.providerSessionId);
      return;
    }

    discoverySinceRef.current = Date.now() - 5000;
    setDiscoveryNonce((n) => n + 1);
  }, [card?.id, launch?.provider, launch?.providerSessionId, markProviderSessionBound]);

  useEffect(() => {
    if (!active || !card || !launch?.provider || !isTauriEnv()) return;
    if (card.providerSessionState === 'bound') return;

    const provider = launch.provider;
    const sinceMs = discoverySinceRef.current;
    if (!sinceMs) return;

    let cancelled = false;
    let attempts = 0;
    let timer: number | null = null;
    const projectPath = card.worktreePath || card.projectPath;

    const find = async (): Promise<void> => {
      if (cancelled || attempts >= DISCOVERY_ATTEMPTS) return;
      attempts += 1;
      try {
        const excluded = collectBoundProviderSessionIds(provider);
        const info = await providerSessions.findRecent(
          provider,
          projectPath,
          sinceMs,
          excluded,
        );
        if (!cancelled && info?.id) {
          markProviderSessionBound(card.id, info.id);
          cancelled = true;
        }
      } catch {
        // Session binding is best-effort; the terminal itself should keep working.
      }
      if (!cancelled && attempts < DISCOVERY_ATTEMPTS) {
        timer = window.setTimeout(() => {
          void find();
        }, DISCOVERY_INTERVAL_MS);
      }
    };

    void find();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    active,
    card?.id,
    card?.projectPath,
    card?.providerSessionState,
    card?.terminalType,
    card?.worktreePath,
    discoveryNonce,
    launch?.provider,
    markProviderSessionBound,
  ]);

  return onInitialCommandSent;
}
