import { isComposingKey } from "./composeKeys";

/**
 * Command-palette key decisions. Kept pure so the IME guard is unit-testable
 * without a DOM: an Enter that confirms an IME candidate must never run a
 * command, and Escape/arrows/Tab belong to the candidate window while it is open.
 */
export type PaletteKeyAction = "ignore" | "close" | "next" | "previous" | "run";
const handled = ["Enter", "Escape", "ArrowDown", "ArrowUp", "Tab"];

export function paletteKeyAction(event: { key: string; isComposing?: boolean; keyCode?: number }): PaletteKeyAction | undefined {
  if (!handled.includes(event.key)) return undefined;
  if (isComposingKey(event)) return "ignore";
  if (event.key === "Escape") return "close";
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  if (event.key === "Enter") return "run";
  return undefined; // Tab: the modal focus trap owns it.
}
