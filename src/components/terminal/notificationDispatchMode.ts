import type { DesktopPetNotificationMode } from '../../types/terminal';

export function shouldDispatchOsNotification(mode: DesktopPetNotificationMode): boolean {
  return mode === 'system' || mode === 'both';
}
