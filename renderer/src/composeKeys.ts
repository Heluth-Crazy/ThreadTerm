/**
 * Compose-box key decisions. Kept pure so the IME guard is unit-testable
 * without a DOM: an Enter that confirms an IME candidate must never run a
 * slash-palette entry such as the destructive `/fork`.
 */
export function slashPaletteEnter(event: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
