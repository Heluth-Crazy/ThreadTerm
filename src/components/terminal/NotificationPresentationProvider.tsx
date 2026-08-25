import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import {
  createNotificationPresentationController,
  notificationPresentationDeliveryBus,
  type NotificationPresentationController,
} from '../../lib/notificationPresentation';

/**
 * The in-app notification presenter is intentionally scoped to one React
 * tree.  Keeping the controller in context (instead of a module singleton)
 * means a direct TerminalManager render in tests, or a second WebView, cannot
 * inherit timers and queued notifications from another tree.
 */
const NotificationPresentationContext = createContext<NotificationPresentationController | null>(
  null,
);

function windowIsFocused(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' &&
    (typeof document.hasFocus !== 'function' || document.hasFocus());
}

function isWindowsRenderer(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}

export function NotificationPresentationProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<NotificationPresentationController | null>(null);
  const disposePendingRef = useRef(false);
  if (controllerRef.current === null) {
    controllerRef.current = createNotificationPresentationController({
      initialNotifications: useTerminalStore.getState().notifications,
      windowFocused: windowIsFocused(),
      awaitDelivery: isWindowsRenderer(),
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    // React StrictMode replays effects without tearing down the component.
    // Defer disposal by one task so that replay can reattach the same scoped
    // controller instead of leaving the context with a disposed instance.
    disposePendingRef.current = false;
    // ManagedStateBootstrap renders App only after persistence hydration. The
    // initial seed above is therefore historical and cannot replay the
    // hydrated ledger; subsequent committed snapshots are runtime evidence.
    const unsubscribe = useTerminalStore.subscribe((state, previousState) => {
      if (state.notifications === previousState.notifications) return;
      controller.ingestSnapshot(state.notifications);
      for (const notification of state.notifications) {
        const decision = notificationPresentationDeliveryBus.get(notification.id);
        if (decision !== undefined) controller.resolveDelivery(notification.id, decision);
      }
    });
    const unsubscribeDelivery = notificationPresentationDeliveryBus.subscribe(
      (notificationId, accepted) => controller.resolveDelivery(notificationId, accepted),
    );

    // Close the seed/listener race: a committed entry may arrive after the
    // controller is created but before the subscription effect runs. The
    // immediate snapshot catch-up admits that entry exactly once (the
    // controller's seen-ID ledger still suppresses duplicates).
    controller.ingestSnapshot(useTerminalStore.getState().notifications);
    for (const notification of useTerminalStore.getState().notifications) {
      const decision = notificationPresentationDeliveryBus.get(notification.id);
      if (decision !== undefined) controller.resolveDelivery(notification.id, decision);
    }

    const syncWindowState = () => {
      const focused = windowIsFocused();
      controller.setWindowFocused(focused);
      controller.setGlobalHidden(!focused);
    };

    syncWindowState();
    window.addEventListener('focus', syncWindowState);
    window.addEventListener('blur', syncWindowState);
    document.addEventListener('visibilitychange', syncWindowState);

    return () => {
      unsubscribe();
      unsubscribeDelivery();
      window.removeEventListener('focus', syncWindowState);
      window.removeEventListener('blur', syncWindowState);
      document.removeEventListener('visibilitychange', syncWindowState);
      disposePendingRef.current = true;
      queueMicrotask(() => {
        if (disposePendingRef.current) controller.dispose();
      });
    };
  }, [controller]);

  const value = useMemo(() => controller, [controller]);
  return (
    <NotificationPresentationContext.Provider value={value}>
      {children}
    </NotificationPresentationContext.Provider>
  );
}

export function useNotificationPresentationController(): NotificationPresentationController | null {
  return useContext(NotificationPresentationContext);
}
