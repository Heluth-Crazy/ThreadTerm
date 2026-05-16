import type {
  DesktopPetConfig,
  DesktopPetDefaultPosition,
  DesktopPetNotificationMode,
  DesktopPetSkin,
} from '../types/terminal';

export const DESKTOP_PET_NOTIFICATION_MODES: DesktopPetNotificationMode[] = [
  'off',
  'system',
  'pet',
  'both',
];

export const DESKTOP_PET_DEFAULT_POSITIONS: DesktopPetDefaultPosition[] = [
  'rightBottom',
  'leftBottom',
  'lastDragged',
];

export const DESKTOP_PET_SKINS: DesktopPetSkin[] = [
  'classic',
  'orange',
  'cream',
  'tuxedo',
  'theme',
];

export const DEFAULT_PET_CONFIG: DesktopPetConfig = {
  enabled: false,
  // 'both' = surface on the pet AND fire an OS notification. Picking the
  // pet's most useful behaviour as the default fixes "启用宠物后通知不弹".
  notificationMode: 'both',
  defaultPosition: 'rightBottom',
  size: 96,
  idleTranslucent: true,
  expanded: false,
  lastPosition: null,
  skin: 'classic',
};

export function normalizePetConfig(input?: Partial<DesktopPetConfig> | null): DesktopPetConfig {
  const size = Number.isFinite(input?.size) ? Number(input?.size) : DEFAULT_PET_CONFIG.size;
  const notificationMode = DESKTOP_PET_NOTIFICATION_MODES.includes(
    input?.notificationMode as DesktopPetNotificationMode,
  )
    ? (input?.notificationMode as DesktopPetNotificationMode)
    : DEFAULT_PET_CONFIG.notificationMode;
  const defaultPosition = DESKTOP_PET_DEFAULT_POSITIONS.includes(
    input?.defaultPosition as DesktopPetDefaultPosition,
  )
    ? (input?.defaultPosition as DesktopPetDefaultPosition)
    : DEFAULT_PET_CONFIG.defaultPosition;
  const skin = DESKTOP_PET_SKINS.includes(input?.skin as DesktopPetSkin)
    ? (input?.skin as DesktopPetSkin)
    : DEFAULT_PET_CONFIG.skin;

  return {
    ...DEFAULT_PET_CONFIG,
    notificationMode,
    defaultPosition,
    skin,
    enabled: input?.enabled === true,
    idleTranslucent: input?.idleTranslucent !== false,
    expanded: input?.expanded === true,
    size: Math.min(120, Math.max(80, size)),
    lastPosition:
      input?.lastPosition &&
      Number.isFinite(input.lastPosition.x) &&
      Number.isFinite(input.lastPosition.y)
        ? { x: input.lastPosition.x, y: input.lastPosition.y }
        : null,
  };
}

/**
 * The four-value `notificationMode` enum is presented in the UI as two
 * independent switches. These helpers map between the two representations so
 * the persisted storage shape stays unchanged (no migration needed).
 *
 *   pet & system → 'both'   pet & !system → 'pet'
 *  !pet & system → 'system' !pet & !system → 'off'
 */
export function notificationModeToToggles(mode: DesktopPetNotificationMode): {
  petBubble: boolean;
  osNotification: boolean;
} {
  return {
    petBubble: mode === 'pet' || mode === 'both',
    osNotification: mode === 'system' || mode === 'both',
  };
}

export function togglesToNotificationMode(
  petBubble: boolean,
  osNotification: boolean,
): DesktopPetNotificationMode {
  if (petBubble && osNotification) return 'both';
  if (petBubble) return 'pet';
  if (osNotification) return 'system';
  return 'off';
}
