import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';
import { logger } from '../../lib/logger';
import { cardMatchesWorktree } from '../../lib/worktreePaths';

/** Pull the native main window to the foreground (no-op outside Tauri). */
function focusMainWindow(): void {
  if (!isTauriEnv()) return;
  invoke('window_focus_main').catch((error) => {
    logger.warn('[notificationTarget] window_focus_main failed', error);
  });
}

/**
 * Open the card that a notification points at.
 *
 * Smart-hybrid targeting:
 *   • pinned card → floating window (unchanged behaviour);
 *   • otherwise → emit a one-shot locate request. TerminalManager resolves it:
 *     stay in the grid (scroll + pulse) when the grid is showing, or open the
 *     focus view otherwise.
 *
 * Store-level filters that would hide the card (project / worktree selection)
 * are corrected here so the locate request always lands on a visible card;
 * the grid-local search query is handled by CardGrid itself.
 */
export function openNotificationTarget(cardId: string): boolean {
  const terminalStore = useTerminalStore.getState();
  const card = terminalStore.getCardById(cardId);
  if (!card) return false;

  terminalStore.markCardRead(cardId);

  // AI Supervisor v0.1 (PRD D10 / R5) — credit a "clicked" telemetry hit when
  // the user opens a notification that maps to a recent supervisor alert.
  // The store self-no-ops if no eligible alert exists for the card, so this
  // call is safe regardless of whether the click came from a supervisor alert
  // or from a generic notification (waiting/completed/failed).
  useSupervisorStore.getState().recordClickByCardId(cardId);

  focusMainWindow();

  const overlayStore = useOverlayStore.getState();
  if (terminalStore.isPinned(cardId) && !overlayStore.lightweightMode) {
    terminalStore.setPendingFocusCardId(cardId);
    overlayStore.openFloat(cardId);
    return true;
  }

  overlayStore.recycleToMain();

  // Smart-hybrid: a user already in the focus view keeps full-screen
  // semantics (`pendingFocusCardId`); a user in the grid stays in the grid
  // and gets a scroll + pulse via the locate channel. `focusedCardId` is the
  // race-free source for "is the focus view showing" — viewMode derives
  // from it.
  if (terminalStore.focusedCardId) {
    terminalStore.setPendingFocusCardId(cardId);
    return true;
  }

  // Switch to a context where the card is actually visible (requirement:
  // cards hidden by project/worktree filters). The grid-local search query
  // is handled by CardGrid itself.
  const { selectedProjectPath, selectedWorktreePath } = terminalStore;
  if (
    (selectedProjectPath && selectedProjectPath !== card.projectPath) ||
    (selectedWorktreePath && !cardMatchesWorktree(card, selectedWorktreePath))
  ) {
    terminalStore.selectProject(card.projectPath);
  }

  terminalStore.setPendingLocateCardId(cardId);
  return true;
}
