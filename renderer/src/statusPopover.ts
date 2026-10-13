export type StatusDismissReason = "escape" | "pointer" | "focus";

/** An open popover owns Escape even after a control blur leaves focus on body.
 * Explicit outside pointer dismissal returns focus without the pointer's default
 * focus move overriding it. Keyboard focus leaving the popover can continue. */
export function listenForStatusDismissal(
  target: EventTarget,
  contains: (node: EventTarget | null) => boolean,
  dismiss: (reason: StatusDismissReason) => void,
): () => void {
  let closed = false;
  const close = (reason: StatusDismissReason) => {
    if (closed) return;
    closed = true;
    dismiss(reason);
  };
  const key = (event: Event) => {
    if (closed || (event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close("escape");
  };
  const pointer = (event: Event) => {
    if (closed || contains(event.target)) return;
    event.preventDefault();
    close("pointer");
  };
  const focus = (event: Event) => {
    if (!closed && !contains(event.target)) close("focus");
  };
  target.addEventListener("keydown", key, true);
  target.addEventListener("pointerdown", pointer, true);
  target.addEventListener("focusin", focus, true);
  return () => {
    closed = true;
    target.removeEventListener("keydown", key, true);
    target.removeEventListener("pointerdown", pointer, true);
    target.removeEventListener("focusin", focus, true);
  };
}
