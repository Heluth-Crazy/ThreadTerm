import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauriEnv, providerSessions } from '../../lib/tauri-bridge';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalCard } from '../../types/terminal';
import type { TerminalLaunchCommand } from './providerSession';

const DISCOVERY_ATTEMPTS = 12;
const DISCOVERY_INTERVAL_MS = 1500;

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
    const projectPath = card.worktreePath || card.projectPath;

    const find = async () => {
      attempts += 1;
      try {
        if (provider !== 'claude' && provider !== 'codex') return;
        const info = await providerSessions.findRecent(provider, projectPath, sinceMs);
        if (!cancelled && info?.id) {
          markProviderSessionBound(card.id, info.id);
          cancelled = true;
        }
      } catch {
        // Session binding is best-effort; the terminal itself should keep working.
      }
    };

    void find();
    const timer = window.setInterval(() => {
      if (cancelled || attempts >= DISCOVERY_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      void find();
    }, DISCOVERY_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
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
