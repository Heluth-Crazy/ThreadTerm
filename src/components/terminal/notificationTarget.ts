import { useOverlayStore } from '../../stores/overlayStore';
import { useTerminalStore } from '../../stores/terminalStore';

export function openNotificationTarget(cardId: string): boolean {
  const terminalStore = useTerminalStore.getState();
  const card = terminalStore.getCardById(cardId);
  if (!card) return false;

  terminalStore.markCardRead(cardId);
  terminalStore.setPendingFocusCardId(cardId);

  if (terminalStore.isPinned(cardId)) {
    useOverlayStore.getState().openFloat(cardId);
    return true;
  }

  useOverlayStore.getState().recycleToMain();
  terminalStore.focusCard(cardId);
  return true;
}
