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
