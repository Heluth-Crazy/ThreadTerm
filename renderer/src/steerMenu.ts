export type SteerMenuDismissReason = 'escape' | 'pointer';

/**
 * An open split-Send menu closes on Escape, returning focus to the arrow, or on
 * an outside pointer-down, which leaves focus where the user clicked (clicking
 * the textarea must not yank it back to the arrow). Returns a disposer.
 */
export function listenForSteerMenuDismissal(
  target: EventTarget,
  contains: (node: EventTarget | null) => boolean,
  dismiss: (reason: SteerMenuDismissReason) => void,
): () => void {
  let closed = false;
  const close = (reason: SteerMenuDismissReason) => {
    if (closed) return;
    closed = true;
    dismiss(reason);
  };
  const key = (event: Event) => {
    if (closed || (event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close('escape');
  };
  // Do not preventDefault: the click's own focus move is the desired one.
  const pointer = (event: Event) => {
    if (closed || contains(event.target)) return;
    close('pointer');
  };
  target.addEventListener('keydown', key, true);
  target.addEventListener('pointerdown', pointer, true);
  return () => {
    closed = true;
    target.removeEventListener('keydown', key, true);
    target.removeEventListener('pointerdown', pointer, true);
  };
}
