/**
 * OverlayHotkeysSettings — rebind the two global overlay shortcuts.
 *
 *   • Hotkey A (selector)  — default Cmd/Ctrl + Shift + Space
 *   • Hotkey B (float↔main) — default Cmd/Ctrl + Shift + O
 *
 * Rebind flow:
 *   1. User clicks "Rebind" on a slot → component enters capture mode.
 *   2. The next keydown is translated to a Tauri accelerator string.
 *   3. We call `overlay_update_shortcut(label, accelerator)` which
 *      unregisters the previous OS-level shortcut and registers the new
 *      one via `tauri-plugin-global-shortcut`, then persists to SQLite.
 *   4. On success we mirror the change into overlayStore so the UI is
 *      consistent across the main + overlay webviews.
 *
 * Safeguards:
 *   • Bare modifiers (Shift alone, Control alone, …) are ignored.
 *   • At least one modifier is required; otherwise the OS will swallow
 *     the user's regular typing.
 *   • Escape cancels the capture.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke, isTauriEnv } from '../../lib/tauri-bridge';
import { useOverlayStore } from '../../stores/overlayStore';

type Slot = 'A' | 'B';

interface SlotMeta {
  label: Slot;
  titleKey: string;
  descriptionKey: string;
  defaultAccelerator: string;
}

const SLOTS: SlotMeta[] = [
  {
    label: 'A',
    titleKey: 'hotkeys.slotA.title',
    descriptionKey: 'hotkeys.slotA.description',
    defaultAccelerator: 'CmdOrCtrl+Shift+Space',
  },
  {
    label: 'B',
    titleKey: 'hotkeys.slotB.title',
    descriptionKey: 'hotkeys.slotB.description',
    defaultAccelerator: 'CmdOrCtrl+Shift+O',
  },
];

// Convert a KeyboardEvent into a Tauri accelerator string (e.g. "CmdOrCtrl+Shift+Space").
// Returns null if the event describes an incomplete combination (no non-modifier key, or
// no modifiers at all).
function keyEventToAccelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('CmdOrCtrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const key = e.key;
  // Modifier-only keys — not a complete binding.
  if (
    key === 'Control' ||
    key === 'Meta' ||
    key === 'Alt' ||
    key === 'Shift' ||
    key === 'CapsLock' ||
    key === 'NumLock' ||
    key === 'ScrollLock'
  ) {
    return null;
  }

  let named: string;
  if (key === ' ') named = 'Space';
  else if (key.length === 1) named = key.toUpperCase();
  else named = key; // Arrow keys, F1-F12, etc. — Tauri accepts as-is.

  parts.push(named);
  if (parts.length < 2) return null; // must have at least one modifier
  return parts.join('+');
}

// Human-readable pill rendering for accelerators, e.g. "CmdOrCtrl+Shift+Space"
// → ["⌘/Ctrl", "⇧", "Space"].
function prettyTokens(accelerator: string): string[] {
  return accelerator.split('+').map((tok) => {
    const t = tok.trim();
    switch (t) {
      case 'CmdOrCtrl':
        return '⌘/Ctrl';
      case 'Cmd':
      case 'Meta':
        return '⌘';
      case 'Ctrl':
      case 'Control':
        return 'Ctrl';
      case 'Shift':
        return '⇧';
      case 'Alt':
      case 'Option':
        return '⌥';
      case 'Space':
        return 'Space';
      default:
        return t;
    }
  });
}

function SlotRow({
  meta,
  current,
  capturing,
  onStartCapture,
  onReset,
  t,
}: {
  meta: SlotMeta;
  current: string;
  capturing: boolean;
  onStartCapture: () => void;
  onReset: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const tokens = prettyTokens(current);

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{t(meta.titleKey)}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{t(meta.descriptionKey)}</div>
      </div>
      <div className="flex items-center gap-2">
        <div
          className={`flex items-center gap-1 rounded-md border px-2 py-1 ${
            capturing
              ? 'border-primary bg-primary/10'
              : 'border-border bg-background'
          }`}
        >
          {capturing ? (
            <span className="font-mono text-[11px] text-primary">
              {t('hotkeys.capture')}
            </span>
          ) : (
            tokens.map((tok, i) => (
              <kbd
                key={i}
                className="inline-flex h-6 min-w-[24px] items-center justify-center rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground"
              >
                {tok}
              </kbd>
            ))
          )}
        </div>
        <button
          type="button"
          onClick={onStartCapture}
          disabled={capturing}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          <Keyboard className="h-3 w-3" />
          {t('hotkeys.rebind')}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={current === meta.defaultAccelerator}
          title={t('hotkeys.resetTitle')}
          className="inline-flex items-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function OverlayHotkeysSettings() {
  const { t } = useTranslation('overlay');
  const hotkeyA = useOverlayStore((s) => s.hotkeyA);
  const hotkeyB = useOverlayStore((s) => s.hotkeyB);
  const updateHotkey = useOverlayStore((s) => s.updateHotkey);

  const [capturing, setCapturing] = useState<Slot | null>(null);
  const [status, setStatus] = useState<{
    slot: Slot;
    kind: 'ok' | 'error';
    message: string;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStatusSoon = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus(null), 2400);
  }, []);

  // Hydrate from Rust on first mount so the UI shows the real OS-level binding.
  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await invoke<{ hotkey_a: string; hotkey_b: string } | null>(
          'overlay_get_settings',
        );
        if (!s || cancelled) return;
        useOverlayStore.getState().setHotkeys(s.hotkey_a, s.hotkey_b);
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Capture-mode keydown listener.
  useEffect(() => {
    if (!capturing) return;
    const slot = capturing;
    const onKey = async (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setCapturing(null);
        return;
      }
      const accel = keyEventToAccelerator(e);
      if (!accel) return; // wait for a full combo
      e.preventDefault();
      e.stopPropagation();
      setCapturing(null);
      try {
        await updateHotkey(slot, accel);
        setStatus({ slot, kind: 'ok', message: t('hotkeys.bound', { accelerator: accel }) });
      } catch (err) {
        setStatus({
          slot,
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearStatusSoon();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, [capturing, updateHotkey, clearStatusSoon, t]);

  const onStartCapture = useCallback((slot: Slot) => {
    setCapturing(slot);
    setStatus(null);
  }, []);

  const onReset = useCallback(
    async (slot: Slot, defaultAccel: string) => {
      try {
        await updateHotkey(slot, defaultAccel);
        setStatus({ slot, kind: 'ok', message: t('hotkeys.reset', { accelerator: defaultAccel }) });
      } catch (err) {
        setStatus({
          slot,
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearStatusSoon();
      }
    },
    [updateHotkey, clearStatusSoon, t],
  );

  return (
    <div className="rounded-xl border border-border/60 bg-card/72 p-4 shadow-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm" role="img" aria-hidden="true">
          🎯
        </span>
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          {t('hotkeys.title')}
        </h4>
        <span className="rounded-full bg-muted/80 px-2 py-0.5 text-[10px] text-muted-foreground">
          {t('hotkeys.scope')}
        </span>
      </div>

      <div className="divide-y divide-border/40">
        {SLOTS.map((meta) => {
          const current = meta.label === 'A' ? hotkeyA : hotkeyB;
          return (
            <SlotRow
              key={meta.label}
              meta={meta}
              current={current}
              capturing={capturing === meta.label}
              onStartCapture={() => onStartCapture(meta.label)}
              onReset={() => onReset(meta.label, meta.defaultAccelerator)}
              t={t}
            />
          );
        })}
      </div>

      {status && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-[11px] ${
            status.kind === 'ok'
              ? 'bg-primary/10 text-primary'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          <span className="font-mono">[{status.slot}]</span>
          <span className="flex-1">{status.message}</span>
          <button
            type="button"
            onClick={() => setStatus(null)}
            className="shrink-0 rounded hover:bg-background/40"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        {t('hotkeys.tips')}
      </div>
    </div>
  );
}

export default OverlayHotkeysSettings;
