/**
 * OS notification preference helpers.
 *
 * Replaces the former `petConfig.notificationMode` four-value enum after the
 * desktop-pet feature was removed. Only the OS-notification dimension survives,
 * as a single boolean. The legacy reader keeps old persisted snapshots and
 * previously exported settings bundles importable.
 */

/** Fresh installs default to OS notifications on. */
export const DEFAULT_OS_NOTIFICATIONS_ENABLED = true;

/**
 * Read the OS-notification preference from data that may predate the
 * `petConfig` → boolean migration. Accepts either the new
 * `osNotificationsEnabled` boolean or a legacy `petConfig.notificationMode`
 * (`'system'` / `'both'` → on, `'off'` / `'pet'` → off). Anything unrecognised
 * falls back to the default.
 */
export function readOsNotificationsEnabled(input: unknown): boolean {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    if (typeof record.osNotificationsEnabled === 'boolean') {
      return record.osNotificationsEnabled;
    }
    const petConfig = record.petConfig;
    if (typeof petConfig === 'object' && petConfig !== null) {
      const mode = (petConfig as Record<string, unknown>).notificationMode;
      if (typeof mode === 'string') {
        return mode === 'system' || mode === 'both';
      }
    }
  }
  return DEFAULT_OS_NOTIFICATIONS_ENABLED;
}
