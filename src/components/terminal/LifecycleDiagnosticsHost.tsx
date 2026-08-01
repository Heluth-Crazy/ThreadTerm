/**
 * LifecycleDiagnosticsHost — mounts the read-only sampling hook used by
 * tools/webview-memory-lifecycle. Does not create windows or change product
 * lifecycle behaviour.
 */
import { useEffect } from 'react';
import { useClaudeChatStore } from '../../stores/claudeChatStore';
import { useCodexRequestStore } from '../../stores/codexRequestStore';
import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  installLifecycleDiagnosticsGlobal,
  registerLifecycleDiagnosticsPublisher,
} from '../../lib/lifecycle/lifecycleDiagnostics';
import {
  deriveTerminalSurfacePhases,
  getMountedTerminalSurfaces,
} from '../../lib/lifecycle/mountedTerminalSurfaces';
import { getTerminalEventBridgeDiagnostics } from './TerminalEventBridge';
import { getXtermRegistryDiagnostics } from './xtermRegistry';
import { getHeadlessPreviewDiagnostics } from './headlessPreview';

function overlayPhase(
  visible: boolean,
  known: boolean,
): 'not-created' | 'visible' | 'hidden-low-memory' | 'destroyed' | 'unknown' {
  if (!known) return 'unknown';
  return visible ? 'visible' : 'hidden-low-memory';
}

export function LifecycleDiagnosticsHost(): null {
  useEffect(() => {
    const uninstallGlobal = installLifecycleDiagnosticsGlobal();
    const unregister = registerLifecycleDiagnosticsPublisher({
      cards: () => {
        const cards = useTerminalStore.getState().cards;
        const activePtyEstimate = cards.filter(
          (card) => card.status === 'running' || card.status === 'waiting',
        ).length;
        return { total: cards.length, activePtyEstimate };
      },
      terminalSurfaces: () => {
        const mounted = getMountedTerminalSurfaces();
        const floatCardId = useOverlayStore.getState().floatCardId;
        const focusedCardId = useTerminalStore.getState().focusedCardId;
        const merged = {
          ...mounted,
          focusedCardId,
          floatCardId,
        };
        const phases = deriveTerminalSurfacePhases(merged);
        return {
          mountedCardIds: merged.mountedCardIds,
          visibleCardIds: phases.visibleCardIds,
          warmCardIds: phases.warmCardIds,
          coldCardIds: phases.coldCardIds,
          focusedCardId,
          floatCardId,
          maxMountedTerminalViews: merged.maxMountedTerminalViews,
          featureFlags: {
            terminalSurfacePoolEnabled: merged.terminalSurfacePoolEnabled,
          },
        };
      },
      xterm: () => {
        const registry = getXtermRegistryDiagnostics();
        return {
          registrationCount: registry.registrationCount,
          distinctPtyIds: registry.distinctPtyIds,
          ptyIds: registry.ptyIds,
          // WebGL is attempted for every non-minimal Shell; exact live count
          // is refined in Batch 2 when surfaces are explicitly tracked.
          webglInstanceCount: registry.registrationCount,
        };
      },
      overlays: () => {
        const overlay = useOverlayStore.getState();
        return {
          selector: overlayPhase(overlay.selectorOpen, true),
          float: overlayPhase(overlay.floatOpen, true),
          // Settings is created on demand in a separate window; presence is
          // not mirrored in overlayStore yet.
          settings: 'unknown' as const,
        };
      },
      chat: () => {
        const sessions = useClaudeChatStore.getState().sessions;
        const claudeCardIds = Object.keys(sessions);
        let claudeItemCount = 0;
        let claudePendingRequestCount = 0;
        for (const session of Object.values(sessions)) {
          claudeItemCount += session.items.length;
          claudePendingRequestCount += session.pendingRequests.length;
        }
        const codexRequests = useCodexRequestStore.getState().requests;
        const codexCardCount = new Set(codexRequests.map((request) => request.cardId)).size;
        return {
          claudeCardCount: claudeCardIds.length,
          claudeItemCount,
          claudePendingRequestCount,
          codexCardCount,
          codexPendingRequestCount: codexRequests.length,
          mountedMessageRowCount: null,
        };
      },
      bridge: () => {
        const bridge = getTerminalEventBridgeDiagnostics();
        const headless = getHeadlessPreviewDiagnostics();
        return {
          activeRuntimeCount: bridge.activeRuntimeCount,
          activeHeadlessCount: headless.activeCount,
          pendingBackgroundOutputCount: bridge.pendingBackgroundOutputCount,
          pendingAckCount: bridge.pendingAckCount,
        };
      },
      workspace: () => ({
        tabCount: 0,
        dirtyTabCount: 0,
        activeTabCount: 0,
        liveEditorInstanceCount: null,
      }),
    });

    return () => {
      unregister();
      uninstallGlobal();
    };
  }, []);

  return null;
}
