import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DEFAULT_PET_CONFIG } from '../lib/petConfig';
import type { DesktopPetConfig, NotificationEntry } from '../types/terminal';
import { invoke, isTauriEnv } from '../lib/tauri-bridge';
import type { PetStatePayload } from './petState';

const EMPTY_STATE: PetStatePayload = {
  cards: [],
  notifications: [],
  unreadCount: 0,
  config: DEFAULT_PET_CONFIG,
  updatedAt: 0,
};

const MOVE_DEBOUNCE_MS = 350;
const BUBBLE_VISIBLE_MS = 2200;

interface UsePetSyncOptions {
  /**
   * Live sprite-local offset (from the resolved geometry). Used to
   * reconstruct the true sprite anchor on drag so a bubble-grown window
   * never drifts the persisted `lastPosition`.
   */
  petLocalRef?: RefObject<{ x: number; y: number }>;
}

export function usePetSync(options: UsePetSyncOptions = {}) {
  const { petLocalRef } = options;
  const [state, setState] = useState<PetStatePayload>(EMPTY_STATE);
  const [latestNotification, setLatestNotification] = useState<NotificationEntry | null>(null);
  const [bubbleHovered, setBubbleHovered] = useState(false);
  const clearNotificationRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armBubbleTimer = () => {
    if (clearNotificationRef.current) {
      clearTimeout(clearNotificationRef.current);
    }
    clearNotificationRef.current = setTimeout(() => {
      setLatestNotification(null);
    }, BUBBLE_VISIBLE_MS);
  };

  useEffect(() => {
    if (!isTauriEnv()) return;
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    (async () => {
      unlisteners.push(
        await listen<PetStatePayload>('pet://state-update', (event) => {
          if (!cancelled && event.payload) {
            setState(event.payload);
          }
        }),
      );
      unlisteners.push(
        await listen<NotificationEntry>('pet://notify', (event) => {
          if (!cancelled && event.payload) {
            setLatestNotification(event.payload);
            // Pause auto-dismiss while the user is hovering the bubble.
            if (!bubbleHovered) {
              armBubbleTimer();
            } else if (clearNotificationRef.current) {
              clearTimeout(clearNotificationRef.current);
            }
          }
        }),
      );
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
      if (clearNotificationRef.current) {
        clearTimeout(clearNotificationRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hover hold: clear the timer on enter, re-arm a fresh window on leave.
  useEffect(() => {
    if (!latestNotification) return;
    if (bubbleHovered) {
      if (clearNotificationRef.current) {
        clearTimeout(clearNotificationRef.current);
        clearNotificationRef.current = null;
      }
    } else {
      armBubbleTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubbleHovered, latestNotification]);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        const win = getCurrentWindow();
        const offMoved = await win.onMoved(() => {
          if (moveTimerRef.current) {
            clearTimeout(moveTimerRef.current);
          }
          moveTimerRef.current = setTimeout(async () => {
            try {
              const pos = await win.outerPosition();
              const factor = await win.scaleFactor();
              if (!cancelled) {
                // Reconstruct the sprite anchor: window origin + sprite-local
                // offset. When a bubble grew the window leftward the origin
                // is not the sprite — adding petLocal recovers the true
                // anchor so persisted position never drifts.
                const local = petLocalRef?.current ?? { x: 0, y: 0 };
                await emit('pet://settings-update', {
                  defaultPosition: 'lastDragged',
                  lastPosition: {
                    x: pos.x / factor + local.x,
                    y: pos.y / factor + local.y,
                  },
                } satisfies Partial<DesktopPetConfig>);
              }
            } catch {
              /* noop */
            }
          }, MOVE_DEBOUNCE_MS);
        });
        if (cancelled) {
          offMoved();
          return;
        }
        unlisteners.push(offMoved);
      } catch {
        /* noop */
      }
    })();

    return () => {
      cancelled = true;
      if (moveTimerRef.current) {
        clearTimeout(moveTimerRef.current);
      }
      unlisteners.forEach((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions = useMemo(
    () => ({
      updateConfig: async (patch: Partial<DesktopPetConfig>) => {
        if (!isTauriEnv()) {
          setState((current) => ({
            ...current,
            config: { ...current.config, ...patch },
          }));
          return;
        }
        await emit('pet://settings-update', patch);
      },
      setExpanded: async (expanded: boolean) => {
        // Optimistic local update for snappy feedback; geometry is driven by
        // usePetGeometry reacting to `config.expanded`. We only persist the
        // intent — no direct window resize here (race fix: the Rust
        // `pet_apply_geometry` is the single window-geometry authority).
        setState((current) => ({
          ...current,
          config: { ...current.config, expanded },
        }));
        if (isTauriEnv()) {
          await emit('pet://settings-update', { expanded } satisfies Partial<DesktopPetConfig>);
        }
      },
      focusCard: async (cardId: string) => {
        if (isTauriEnv()) {
          await invoke('pet_focus_main_to_card', { cardId });
        }
      },
      openNotificationCenter: async () => {
        if (isTauriEnv()) {
          await invoke('pet_open_notification_center');
        }
      },
    }),
    [],
  );

  return { state, latestNotification, bubbleHovered, setBubbleHovered, ...actions };
}
