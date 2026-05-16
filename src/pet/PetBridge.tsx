import { useEffect, useRef } from 'react';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke, isTauriEnv } from '../lib/tauri-bridge';
import { useOverlayStore } from '../stores/overlayStore';
import { useTerminalStore } from '../stores/terminalStore';
import type { DesktopPetConfig } from '../types/terminal';
import { buildPetState } from './petState';

/**
 * Show/hide only. Window size + position are owned exclusively by the Rust
 * `pet_apply_geometry` authority (driven from the pet webview's
 * `usePetGeometry`). Keeping resize/move out of here is the race fix — there
 * is no longer a second code path fighting the geometry engine.
 */
async function syncPetWindow(enabled: boolean): Promise<void> {
  if (!isTauriEnv()) return;
  if (enabled) {
    await invoke('pet_show');
  } else {
    await invoke('pet_hide');
  }
}

async function emitPetState(): Promise<void> {
  if (!isTauriEnv()) return;
  const state = useTerminalStore.getState();
  await emit(
    'pet://state-update',
    buildPetState({
      cards: state.cards,
      notifications: state.notifications,
      config: state.petConfig,
    }),
  );
}

export function PetBridge(): null {
  const lastEnabledRef = useRef(useTerminalStore.getState().petConfig.enabled);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    (async () => {
      unlisteners.push(
        await listen<Partial<DesktopPetConfig>>('pet://settings-update', (event) => {
          useTerminalStore.getState().updatePetConfig(event.payload ?? {});
        }),
      );
      unlisteners.push(
        await listen<string>('pet://focus-card', (event) => {
          const cardId = typeof event.payload === 'string' ? event.payload : null;
          if (!cardId) return;
          const store = useTerminalStore.getState();
          if (!store.getCardById(cardId)) return;
          store.markCardRead(cardId);
          store.setPendingFocusCardId(cardId);
          store.focusCard(cardId);
          useOverlayStore.setState({
            selectorOpen: false,
            floatOpen: false,
            floatHiddenByOverlay: false,
          });
        }),
      );
      unlisteners.push(
        await listen('pet://open-notification-center', () => {
          useTerminalStore.getState().toggleNotificationCentre(true);
          useOverlayStore.setState({
            selectorOpen: false,
            floatOpen: false,
            floatHiddenByOverlay: false,
          });
        }),
      );

      if (!cancelled) {
        await emitPetState();
        await syncPetWindow(useTerminalStore.getState().petConfig.enabled);
      }
    })();

    const unsubscribe = useTerminalStore.subscribe((state, prev) => {
      const configChanged = state.petConfig !== prev.petConfig;
      if (
        state.cards !== prev.cards ||
        state.notifications !== prev.notifications ||
        configChanged
      ) {
        void emitPetState();
      }

      // Only show/hide on the enabled toggle. Position/size/expanded never
      // call into the window here — geometry is the Rust authority's job.
      if (state.petConfig.enabled !== lastEnabledRef.current) {
        lastEnabledRef.current = state.petConfig.enabled;
        void syncPetWindow(state.petConfig.enabled);
      }

      if (state.notifications !== prev.notifications && state.petConfig.enabled) {
        const prevIds = new Set(prev.notifications.map((notification) => notification.id));
        const mode = state.petConfig.notificationMode;
        if (mode === 'pet' || mode === 'both') {
          for (const notification of state.notifications) {
            if (!prevIds.has(notification.id)) {
              void emit('pet://notify', notification);
            }
          }
        }
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unlisteners.forEach((off) => off());
    };
  }, []);

  return null;
}
