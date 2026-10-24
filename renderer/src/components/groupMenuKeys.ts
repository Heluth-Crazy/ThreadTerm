import type { FocusEvent, KeyboardEvent } from 'react';

/** Keep shared-button pickers keyboard-equivalent to the Select they replace. */
export function groupMenuKeys(event: KeyboardEvent<HTMLElement>, open: boolean, setOpen: (open: boolean) => void) {
  const root = event.currentTarget;
  const trigger = root.querySelector<HTMLButtonElement>('button[aria-haspopup]');
  if (event.key === 'Escape') {
    if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger?.focus(); }
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const focusOption = () => {
    const options = [...root.querySelectorAll<HTMLButtonElement>('[role=option]:not(:disabled)')];
    if (!options.length) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : current < 0 ? event.key === 'ArrowUp' ? options.length - 1 : 0
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };
  if (open) focusOption();
  else { setOpen(true); requestAnimationFrame(focusOption); }
}

export function groupMenuBlur(event: FocusEvent<HTMLElement>, setOpen: (open: boolean) => void) {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
}
