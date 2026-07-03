import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSupervisorStore } from '../../lib/supervisor/supervisorStore';

export function openNotificationTarget(cardId: string): boolean {
  const terminalStore = useTerminalStore.getState();
  const card = terminalStore.getCardById(cardId);
  if (!card) return false;

  terminalStore.markCardRead(cardId);
  terminalStore.setPendingFocusCardId(cardId);

  // AI Supervisor v0.1 (PRD D10 / R5) — credit a "clicked" telemetry hit when
  // the user opens a notification that maps to a recent supervisor alert.
  // The store self-no-ops if no eligible alert exists for the card, so this
  // call is safe regardless of whether the click came from a supervisor alert
  // or from a generic notification (waiting/completed/failed).
  useSupervisorStore.getState().recordClickByCardId(cardId);

  const overlayStore = useOverlayStore.getState();
  if (terminalStore.isPinned(cardId) && !overlayStore.lightweightMode) {
    overlayStore.openFloat(cardId);
    return true;
  }

  overlayStore.recycleToMain();
  terminalStore.focusCard(cardId);
  return true;
}
