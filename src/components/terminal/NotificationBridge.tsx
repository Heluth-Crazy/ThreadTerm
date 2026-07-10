/**
 * NotificationBridge
 *
 * Headless component that reacts to in-app notifications produced by the
 * {@link TerminalEventBridge} and surfaces them as OS notifications via
 * `@tauri-apps/plugin-notification`. Also listens for notification-action
 * clicks and focuses the originating card when the user clicks a toast.
 *
 * Graceful degradation:
 *   • If permission isn't granted yet, request it on first mount.
 *   • If the user denies, we silently fall back to the in-app bell.
 *   • In web/browser mode where Tauri isn't available, no OS toast is shown
 *     but the store still receives the entry.
 */
import { useEffect, useRef } from 'react';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  onAction,
} from '@tauri-apps/plugin-notification';
import { useTerminalStore } from '../../stores/terminalStore';
import type { NotificationEntry } from '../../types/terminal';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';
import { logger } from '../../lib/logger';
import i18n from '../../i18n/config';
import { openNotificationTarget } from './notificationTarget';
import { describeCardSource, formatCardSourceLabel } from './notificationSource';

// Encodes a cardId into a numeric notification id that Tauri accepts.
// We use a hash so repeated notifications for the same card share an id
// slot and can be de-duplicated by the OS.
function hashCardIdToNotifId(cardId: string): number {
  let h = 0;
  for (let i = 0; i < cardId.length; i++) {
    h = (h << 5) - h + cardId.charCodeAt(i);
    h |= 0; // force int32
  }
  // Positive 30-bit int — stay comfortably inside the 32-bit signed range.
  return Math.abs(h) % 0x3fffffff;
}

export function NotificationBridge(): null {
  // Track which notification ids we've already sent so we don't replay them
  // on React effect re-runs (StrictMode, fast refresh, persistence rehydrate).
  const sentIdsRef = useRef<Set<string>>(new Set());

  // 1. Request permission once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauriEnv()) return;
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const result = await requestPermission();
          granted = result === 'granted';
        }
        if (!cancelled && !granted) {
          logger.warn('[NotificationBridge] OS notification permission was not granted on mount');
        }
      } catch {
        /* ignore — bell still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Subscribe to OS notification clicks → queue focus + open the card.
  useEffect(() => {
    if (!isTauriEnv()) return;
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        const listener = await onAction((options) => {
          // We stashed the cardId as `options.extra?.cardId` when firing;
          // `extra` is not part of Options but tauri forwards unknown keys.
          const cardId =
            (options as { extra?: { cardId?: string } }).extra?.cardId ??
            extractCardIdFromTitle(options.title ?? '');
          if (!cardId) return;
          openNotificationTarget(cardId);
        });
        unsub = () => listener.unregister();
      } catch {
        /* ignore */
      }
    })();
    return () => {
      unsub?.();
    };
  }, []);

  // 3. Whenever a new notification lands in the store, dispatch it to the OS.
  useEffect(() => {
    const unsub = useTerminalStore.subscribe((state, prev) => {
      if (state.notifications === prev.notifications) return;
      // find entries present in `state.notifications` but not in `prev.notifications`
      const prevIds = new Set(prev.notifications.map((n) => n.id));
      for (const n of state.notifications) {
        if (prevIds.has(n.id)) continue;
        if (sentIdsRef.current.has(n.id)) continue;
        if (!state.osNotificationsEnabled) continue;
        sentIdsRef.current.add(n.id);
        void dispatchOsNotification(n);
      }
    });
    return unsub;
  }, []);

  // 4. Periodic purge of read notifications older than 2 hours so the bell
  //    doesn't accumulate noise across long sessions. We run this every
  //    minute, which is cheap (a single `filter` over a bounded array).
  useEffect(() => {
    const TWO_HOURS_MS = 2 * 60 * 60_000;
    // Kick once on mount to catch leftovers from a previous session.
    useTerminalStore.getState().purgeReadNotifications(TWO_HOURS_MS);
    const handle = setInterval(() => {
      useTerminalStore.getState().purgeReadNotifications(TWO_HOURS_MS);
    }, 60_000);
    return () => clearInterval(handle);
  }, []);

  return null;
}

async function dispatchOsNotification(n: NotificationEntry): Promise<void> {
  if (!isTauriEnv()) return;
  const body = buildOsNotificationBody(n);
  try {
    await invoke('notification_send_os', {
      title: n.title,
      body,
      cardId: n.cardId,
    });
    return;
  } catch (error) {
    logger.warn('[NotificationBridge] Rust OS notification failed; falling back to Web Notification', error);
  }

  try {
    const granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      if (permission !== 'granted') {
        logger.warn('[NotificationBridge] OS notification permission was not granted', permission);
        return;
      }
    }
    sendNotification({
      id: hashCardIdToNotifId(n.cardId),
      title: n.title,
      body,
      // `extra` is forwarded to the onAction callback so we can round-trip cardId.
      // This is an unknown field on `Options` but tolerated by the plugin.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...( { extra: { cardId: n.cardId } } as any ),
    });
  } catch (error) {
    logger.warn('[NotificationBridge] Web Notification fallback failed', error);
  }
}

// Prefix the OS notification body with the originating card's source label
// ("ThreadTerm · repo · Codex · Fix") so the user can tell which card fired
// the toast without opening the app. Falls back to the raw body when the
// notification isn't tied to a live card (e.g. `system:*` events).
function buildOsNotificationBody(n: NotificationEntry): string {
  const card = useTerminalStore.getState().getCardById(n.cardId);
  if (!card) return n.body;
  const source = formatCardSourceLabel(describeCardSource(card), (key, fallback) =>
    i18n.t(`terminal:${key}`, fallback ?? key),
  );
  const header = `ThreadTerm · ${source}`;
  return n.body ? `${header}\n${n.body}` : header;
}

// Fallback: in case `extra` isn't round-tripped by the plugin, some titles
// embed `[cardId]` — we can parse it back out. Kept small and best-effort.
function extractCardIdFromTitle(title: string): string | null {
  const m = title.match(/\[([a-z0-9]+-[a-z0-9]+)\]/i);
  return m ? m[1] : null;
}
