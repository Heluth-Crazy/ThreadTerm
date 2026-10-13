import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listenForStatusDismissal } from "../statusPopover";

/** Status dialogs share dismissal and focus behavior without any idle work. */
export function useStatusPopover() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const toggle = () => { if (open) close(); else setOpen(true); };
  useEffect(() => {
    if (!open) return;
    dialog.current?.focus({ preventScroll: true });
    return listenForStatusDismissal(document,
      node => node instanceof Node && Boolean(anchor.current?.contains(node)),
      reason => close(reason !== "focus"));
  }, [open, close]);
  return { open, setOpen, toggle, anchor, trigger, dialog, id };
}
