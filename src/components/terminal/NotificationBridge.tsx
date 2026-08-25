/**
 * Application-scoped OS notification bridge.
 *
 * The Rust command owns native/plugin delivery and activation identity. This
 * component only subscribes to committed ledger entries, listens for the
 * event-level activation payload, and resolves that payload back through the
 * notification ledger before navigation or acknowledgement.
 */
import { useEffect } from 'react';
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';
import { useTerminalStore } from '../../stores/terminalStore';
import type { NotificationEntry } from '../../types/terminal';
import { isTauriEnv } from '../../lib/tauri-bridge';
import { logger } from '../../lib/logger';
import { OsNotificationCoordinator } from '../../lib/osNotificationPolicy';
import { notificationPresentationDeliveryBus } from '../../lib/notificationPresentation';
import {
  buildNotificationBody,
  notificationActivationReady,
  notificationFeedbackBus,
  notificationTestActivationRegistry,
  publishNotificationTargetFeedback,
  sendOsNotification,
  subscribeNotificationActivations,
} from '../../lib/notificationDelivery';
import i18n from '../../i18n/config';
import { openNotificationTarget, resolveNotificationTarget } from './notificationTarget';
import { describeCardSource, formatCardSourceLabel } from './notificationSource';

export function NotificationBridge(): null {
  // Request permission once on mount. Native delivery and the in-app ledger do
  // not depend on this best-effort permission prompt.
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
          logger.warn('[NotificationBridge] OS permission was not granted', {
            channel: 'permission',
            status: 'disabled-by-system',
          });
        }
      } catch {
        logger.warn('[NotificationBridge] OS permission check failed', {
          channel: 'permission',
          status: 'failed',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Listener -> Rust pending drain -> store subscription is one ordered chain.
  // Historical IDs seed the coordinator, while the immediate post-subscribe
  // snapshot closes the render/listener race for events committed meanwhile.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unsubscribeStore: (() => void) | null = null;
    const seenStoreIds = new Set(
      useTerminalStore.getState().notifications.map((notification) => notification.id),
    );

    const handleActivation = async (notificationId: string): Promise<void> => {
      if (disposed) return;

      // Settings test toasts are intentionally runtime-only and never enter
      // the ledger. They still carry an event ID and an exact optional card ID.
      const testActivation = notificationTestActivationRegistry.consume(notificationId);
      if (testActivation) {
        if (!testActivation.cardId) {
          testActivation.onClicked();
          return;
        }
        if (openNotificationTarget(testActivation.cardId)) {
          testActivation.onClicked();
        } else {
          notificationFeedbackBus.publish({
            notificationId,
            cardId: testActivation.cardId,
            kind: 'error',
            feedbackKey: 'notifications.targetNavigationFailed',
          });
          useTerminalStore.getState().toggleNotificationCentre(true);
        }
        return;
      }

      const entry = useTerminalStore
        .getState()
        .notifications.find((notification) => notification.id === notificationId);
      if (!entry) {
        // Native payloads intentionally contain no card ID. A missing ledger
        // event cannot safely guess a target or acknowledge a sibling event.
        notificationFeedbackBus.publish({
          notificationId,
          cardId: null,
          kind: 'stale',
          feedbackKey: 'notifications.targetNavigationFailed',
        });
        useTerminalStore.getState().toggleNotificationCentre(true);
        return;
      }

      const result = await resolveNotificationTarget(notificationId, entry.cardId);
      // Once an activation has been accepted by the process relay, finish
      // target resolution even if React replays/unmounts this effect. The
      // relay owns delivery identity; an effect cleanup must not turn an
      // in-flight error or acknowledgement into a dropped activation.
      if (result.accepted) return;
      publishNotificationTargetFeedback({
        notificationId,
        cardId: entry.cardId,
        kind: result.kind === 'missing' || result.kind === 'stale' ? result.kind : 'error',
        feedbackKey: result.feedbackKey,
      });
      useTerminalStore.getState().toggleNotificationCentre(true);
    };

    const coordinator = new OsNotificationCoordinator({
      getEnvironment: () => {
        const state = useTerminalStore.getState();
        return {
          enabled: state.osNotificationsEnabled,
          foreground:
            document.visibilityState === 'visible' && document.hasFocus(),
          focusedCardId: state.focusedCardId,
          platform: /Windows/i.test(navigator.userAgent) ? 'windows' : 'unknown',
        };
      },
      dispatch: dispatchOsNotification,
      onSuppressed: (notification) => {
        notificationPresentationDeliveryBus.resolve(notification.id, false);
      },
    });

    void (async () => {
      try {
        // Subscribe synchronously before awaiting the process-scoped
        // listener/drain lease. The relay buffers IDs if StrictMode removes
        // this effect during the deferred drain and flushes them to the next
        // lease holder exactly once.
        unlisten = subscribeNotificationActivations({ onNotificationId: handleActivation });
        const activationReady = await notificationActivationReady();
        if (!activationReady) {
          // Fail closed: without a native activation listener, do not start
          // new OS dispatches that would create unclickable toasts.
          unlisten();
          unlisten = null;
          return;
        }
        if (disposed) {
          unlisten();
          unlisten = null;
          return;
        }

        unsubscribeStore = useTerminalStore.subscribe((state, previousState) => {
          if (disposed || state.notifications === previousState.notifications) return;
          const previousIds = new Set(previousState.notifications.map((n) => n.id));
          for (const notification of state.notifications) {
            if (previousIds.has(notification.id) || seenStoreIds.has(notification.id)) continue;
            seenStoreIds.add(notification.id);
            coordinator.accept(notification);
          }
        });

        // Catch entries committed after render but before subscription. The
        // coordinator remains seeded with the hydrated IDs above.
        for (const notification of useTerminalStore.getState().notifications) {
          if (seenStoreIds.has(notification.id)) continue;
          seenStoreIds.add(notification.id);
          coordinator.accept(notification);
        }
      } catch {
        logger.warn('[NotificationBridge] activation channel setup failed', {
          notificationId: null,
          channel: 'activation',
          status: 'failed',
        });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      unsubscribeStore?.();
      coordinator.dispose();
      seenStoreIds.clear();
    };
  }, []);

  // Purge only the bounded read history. Unread ledger evidence is retained.
  useEffect(() => {
    const TWO_HOURS_MS = 2 * 60 * 60_000;
    useTerminalStore.getState().purgeReadNotifications(TWO_HOURS_MS);
    const handle = setInterval(() => {
      useTerminalStore.getState().purgeReadNotifications(TWO_HOURS_MS);
    }, 60_000);
    return () => clearInterval(handle);
  }, []);

  return null;
}

async function dispatchOsNotification(notification: NotificationEntry): Promise<void> {
  const state = useTerminalStore.getState();
  const card = state.getCardById(notification.cardId);
  const sourceLabel = card
    ? formatCardSourceLabel(describeCardSource(card), (key, fallback) =>
        i18n.t(`terminal:${key}`, fallback ?? key),
      )
    : null;
  const body = buildNotificationBody({
    sourceLabel,
    summary: notification.body,
    previewEnabled: state.osNotificationPreviewEnabled,
  });
  const receipt = await sendOsNotification({
    notificationId: notification.id,
    cardId: notification.cardId,
    title: notification.title,
    body,
  });
  notificationPresentationDeliveryBus.resolve(
    notification.id,
    receipt.channel === 'windows-native' && receipt.status === 'accepted',
  );
}
