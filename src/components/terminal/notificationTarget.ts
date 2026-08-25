import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore, type ArchivedTerminalCard } from '../../stores/terminalStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';
import { logger } from '../../lib/logger';
import { cardMatchesWorktree } from '../../lib/worktreePaths';

export type NotificationTargetFeedbackKey =
  | 'notifications.targetUnavailable'
  | 'notifications.targetNavigationFailed';

export type NotificationTargetResolution =
  | {
      kind: 'active';
      accepted: true;
      acknowledged: true;
      notificationId: string;
      cardId: string;
    }
  | {
      kind: 'archived';
      accepted: true;
      acknowledged: true;
      notificationId: string;
      cardId: string;
    }
  | {
      kind: 'missing';
      accepted: false;
      acknowledged: true;
      notificationId: string;
      cardId: string;
      /** Translation key for the caller's unavailable-target feedback. */
      feedbackKey: 'notifications.targetUnavailable';
    }
  | {
      kind: 'stale';
      accepted: false;
      acknowledged: false;
      notificationId: string;
      cardId: string;
      feedbackKey: 'notifications.targetNavigationFailed';
      error: Error;
    }
  | {
      kind: 'error';
      accepted: false;
      acknowledged: false;
      notificationId: string;
      cardId: string;
      feedbackKey: 'notifications.targetNavigationFailed';
      error: unknown;
    };

export interface ArchivedNotificationTarget {
  notificationId: string;
  cardId: string;
  card: ArchivedTerminalCard;
}

export type ArchivedNotificationNavigation = (
  target: ArchivedNotificationTarget,
) => Promise<void>;

let archivedNotificationNavigation: ArchivedNotificationNavigation | null = null;
const pendingTargetResolutions = new Map<string, Promise<NotificationTargetResolution>>();
const settledTargetResolutions = new Map<string, NotificationTargetResolution>();
const MAX_SETTLED_TARGET_RESOLUTIONS = 256;

function staleTargetResolution(
  notificationId: string,
  cardId: string,
  reason: string,
): NotificationTargetResolution {
  return {
    kind: 'stale',
    accepted: false,
    acknowledged: false,
    notificationId,
    cardId,
    feedbackKey: 'notifications.targetNavigationFailed',
    error: new Error(reason),
  };
}

/**
 * Register the mounted archive surface's navigation bridge. The callback
 * resolves only after the snapshot has been opened, scrolled into view, and
 * pulsed, so acknowledgement never races the archive UI.
 */
export function registerArchivedNotificationNavigation(
  navigation: ArchivedNotificationNavigation,
): () => void {
  archivedNotificationNavigation = navigation;
  return () => {
    if (archivedNotificationNavigation === navigation) {
      archivedNotificationNavigation = null;
    }
  };
}

/** Pull the native main window to the foreground (no-op outside Tauri). */
async function focusMainWindow(): Promise<void> {
  if (!isTauriEnv()) return;
  await invoke('window_focus_main');
}

/**
 * Perform active-card navigation without acknowledgement or window focusing.
 * The async resolver owns those boundaries so failures can leave the event
 * unread and callers can distinguish accepted navigation from a stale target.
 */
function navigateActiveTarget(cardId: string): boolean {
  const terminalStore = useTerminalStore.getState();
  const card = terminalStore.getCardById(cardId);
  if (!card) return false;

  terminalStore.markCardRead(cardId);

  // AI Supervisor v0.1 (PRD D10 / R5) — credit a "clicked" telemetry hit when
  // the user opens a notification that maps to a recent supervisor alert.
  // The store self-no-ops if no eligible alert exists for the card, so this
  // call is safe regardless of whether the click came from a generic event.
  useSupervisorStore.getState().recordClickByCardId(cardId);

  const overlayStore = useOverlayStore.getState();
  if (terminalStore.isPinned(cardId) && !overlayStore.lightweightMode) {
    terminalStore.setPendingFocusCardId(cardId);
    overlayStore.openFloat(cardId);
    return true;
  }

  overlayStore.recycleToMain();

  // Smart-hybrid: a user already in the focus view keeps full-screen
  // semantics; a user in the grid stays in the grid and gets a scroll + pulse.
  if (terminalStore.focusedCardId) {
    terminalStore.setPendingFocusCardId(cardId);
    return true;
  }

  // Switch to a context where the card is actually visible. The grid-local
  // search query is handled by CardGrid itself.
  const { selectedProjectPath, selectedWorktreePath } = terminalStore;
  if (
    (selectedProjectPath && selectedProjectPath !== card.projectPath) ||
    (selectedWorktreePath && !cardMatchesWorktree(card, selectedWorktreePath))
  ) {
    if (card.worktreePath) {
      terminalStore.selectWorktree(card.projectPath, card.worktreePath, card.branchLabel);
    } else {
      terminalStore.selectProject(card.projectPath);
    }
  }

  terminalStore.setPendingLocateCardId(cardId);
  return true;
}

/**
 * Legacy non-notification activation API. New notification callers must use
 * `resolveNotificationTarget(notificationId, cardId)` so acknowledgement is
 * scoped to one ledger entry and can wait for native focus/archive UI.
 */
export function openNotificationTarget(cardId: string): boolean {
  try {
    void focusMainWindow().catch((error) => {
      logger.warn('[notificationTarget] legacy window focus failed', error);
    });
    return navigateActiveTarget(cardId);
  } catch (error) {
    logger.warn('[notificationTarget] legacy navigation failed', error);
    return false;
  }
}

/**
 * Resolve and navigate one notification target. The notification is
 * acknowledged only after native focus and target navigation are accepted.
 * Missing targets are terminal degraded outcomes and are acknowledged; any
 * unexpected error leaves the notification unread.
 */
export function resolveNotificationTarget(
  notificationId: string,
  cardId: string,
): Promise<NotificationTargetResolution> {
  const ledgerEntry = useTerminalStore
    .getState()
    .notifications.find((notification) => notification.id === notificationId);
  if (!ledgerEntry) {
    return Promise.resolve(
      staleTargetResolution(notificationId, cardId, 'notification ledger entry is missing'),
    );
  }
  if (ledgerEntry.cardId !== cardId) {
    return Promise.resolve(
      staleTargetResolution(
        notificationId,
        cardId,
        'notification target card does not match its ledger entry',
      ),
    );
  }

  const key = `${notificationId}:${cardId}`;
  const settled = settledTargetResolutions.get(key);
  if (settled) return Promise.resolve(settled);
  const pending = pendingTargetResolutions.get(key);
  if (pending) return pending;

  const promise = resolveNotificationTargetInternal(notificationId, cardId);
  pendingTargetResolutions.set(key, promise);
  void promise.then(
    (result) => {
      if (pendingTargetResolutions.get(key) === promise) {
        pendingTargetResolutions.delete(key);
      }
      if (result.kind === 'error') return;
      settledTargetResolutions.set(key, result);
      while (settledTargetResolutions.size > MAX_SETTLED_TARGET_RESOLUTIONS) {
        const oldest = settledTargetResolutions.keys().next().value;
        if (oldest === undefined) break;
        settledTargetResolutions.delete(oldest);
      }
    },
    () => {
      if (pendingTargetResolutions.get(key) === promise) {
        pendingTargetResolutions.delete(key);
      }
    },
  );
  return promise;
}

async function resolveNotificationTargetInternal(
  notificationId: string,
  cardId: string,
): Promise<NotificationTargetResolution> {
  try {
    const initialLedgerEntry = useTerminalStore
      .getState()
      .notifications.find((notification) => notification.id === notificationId);
    if (!initialLedgerEntry || initialLedgerEntry.cardId !== cardId) {
      return staleTargetResolution(
        notificationId,
        cardId,
        !initialLedgerEntry
          ? 'notification ledger entry disappeared before focus'
          : 'notification target card changed before focus',
      );
    }

    // Capture the target's lifecycle at activation time. If an archived
    // snapshot disappears while the archive surface is being opened, that is
    // a navigation failure (and must remain unread), not a deleted-target
    // acknowledgement. This also prevents a concurrent restore/delete race
    // from silently changing the meaning of the clicked event.
    const initialState = useTerminalStore.getState();
    const initialActiveCard = initialState.getCardById(cardId);
    const initialArchivedCard = (initialState.archivedCards ?? []).find(
      (card) => card.id === cardId,
    );

    // A deleted target has no navigation work to perform. Resolve it from
    // the activation-time snapshot so a native focus failure cannot turn a
    // terminal missing-target outcome into an unrelated navigation error.
    if (!initialActiveCard && !initialArchivedCard) {
      initialState.markNotificationRead(notificationId);
      return {
        kind: 'missing',
        accepted: false,
        acknowledged: true,
        notificationId,
        cardId,
        feedbackKey: 'notifications.targetUnavailable',
      };
    }

    await focusMainWindow();

    const terminalStore = useTerminalStore.getState();
    const currentLedgerEntry = terminalStore.notifications.find(
      (notification) => notification.id === notificationId,
    );
    if (!currentLedgerEntry || currentLedgerEntry.cardId !== cardId) {
      return staleTargetResolution(
        notificationId,
        cardId,
        !currentLedgerEntry
          ? 'notification ledger entry disappeared during focus'
          : 'notification target card changed during focus',
      );
    }
    const activeCard = terminalStore.getCardById(cardId);
    if (initialActiveCard && !activeCard) {
      throw new Error('active notification target disappeared during navigation');
    }
    if (initialArchivedCard && activeCard) {
      throw new Error('archived notification target changed to an active card');
    }
    if (activeCard) {
      if (!navigateActiveTarget(cardId)) {
        throw new Error('active notification target disappeared during navigation');
      }
      const activeLedgerEntry = useTerminalStore
        .getState()
        .notifications.find((notification) => notification.id === notificationId);
      if (!activeLedgerEntry || activeLedgerEntry.cardId !== cardId) {
        return staleTargetResolution(
          notificationId,
          cardId,
          !activeLedgerEntry
            ? 'notification ledger entry disappeared before acknowledgement'
            : 'notification target card changed before acknowledgement',
        );
      }
      terminalStore.markNotificationRead(notificationId);
      return {
        kind: 'active',
        accepted: true,
        acknowledged: true,
        notificationId,
        cardId,
      };
    }

    const archivedCard = (terminalStore.archivedCards ?? []).find(
      (card) => card.id === cardId,
    );
    if (initialArchivedCard && !archivedCard) {
      throw new Error('archived notification target disappeared during navigation');
    }
    if (archivedCard) {
      if (!archivedNotificationNavigation) {
        throw new Error('archive notification navigation is not mounted');
      }
      await archivedNotificationNavigation({ notificationId, cardId, card: archivedCard });
      const archivedLedgerEntry = useTerminalStore
        .getState()
        .notifications.find((notification) => notification.id === notificationId);
      if (!archivedLedgerEntry || archivedLedgerEntry.cardId !== cardId) {
        return staleTargetResolution(
          notificationId,
          cardId,
          !archivedLedgerEntry
            ? 'notification ledger entry disappeared before acknowledgement'
            : 'notification target card changed before acknowledgement',
        );
      }
      useTerminalStore.getState().markNotificationRead(notificationId);
      return {
        kind: 'archived',
        accepted: true,
        acknowledged: true,
        notificationId,
        cardId,
      };
    }

    // A deleted card has no actionable destination, but the clicked event is
    // still terminal and must not affect any sibling notification for the card.
    terminalStore.markNotificationRead(notificationId);
    return {
      kind: 'missing',
      accepted: false,
      acknowledged: true,
      notificationId,
      cardId,
      feedbackKey: 'notifications.targetUnavailable',
    };
  } catch (error) {
    logger.warn('[notificationTarget] navigation failed', error);
    return {
      kind: 'error',
      accepted: false,
      acknowledged: false,
      notificationId,
      cardId,
      feedbackKey: 'notifications.targetNavigationFailed',
      error,
    };
  }
}
