export type NotificationKind = 'attention' | 'completed';
export type NotificationPreferences = { native: boolean; attention: boolean; completed: boolean; sound: boolean };

export function notificationPreferences(value: unknown): NotificationPreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    // Native delivery has always required an explicit opt-in. The newer kinds
    // preserve delivery for an existing `{native:true}` setting.
    native: source.native === true,
    attention: source.attention !== false,
    completed: source.completed !== false,
    sound: source.sound === true,
  };
}

export function shouldShowNativeNotification(value: unknown, kind: NotificationKind): boolean {
  const preferences = notificationPreferences(value);
  return preferences.native && preferences[kind];
}

export type NativeDelivery = { deliver: true; silent: boolean } | { deliver: false; reason: 'disabled' | 'kind-disabled' | 'app-focused' };
/** Whether an OS notification goes out. Session events notify only while no ThreadTerm window has focus (in the app
 * the inbox badge and attention banner already say it). A test from Settings needs consent only: it shows how a
 * notification looks even though Settings itself has focus, whatever the per-kind switches say. */
export function nativeDelivery(value: unknown, kind: NotificationKind, context: { appFocused: boolean; test?: boolean }): NativeDelivery {
  const preferences = notificationPreferences(value);
  if (!preferences.native) return { deliver: false, reason: 'disabled' };
  if (!context.test && !preferences[kind]) return { deliver: false, reason: 'kind-disabled' };
  if (!context.test && context.appFocused) return { deliver: false, reason: 'app-focused' };
  return { deliver: true, silent: !preferences.sound };
}
