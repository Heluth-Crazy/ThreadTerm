import { useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke, isTauriEnv } from '../lib/tauri-bridge';
import type { DesktopPetConfig, PetGeometry, PetVisual } from '../types/terminal';

interface GeometryInputs {
  enabled: boolean;
  expanded: boolean;
  hasBubble: boolean;
  config: DesktopPetConfig;
}

interface PetGeometryIntent {
  visual: PetVisual;
  size: number;
  anchor: { x: number; y: number } | null;
  corner: 'rightBottom' | 'leftBottom';
}

/** collapsed < bubble < expanded — used to debounce only *shrink* passes. */
const VISUAL_RANK: Record<PetVisual, number> = {
  collapsed: 0,
  bubble: 1,
  expanded: 2,
};

const RETRACT_DEBOUNCE_MS = 120;

function deriveVisual(inputs: GeometryInputs): PetVisual {
  if (inputs.expanded) return 'expanded';
  if (inputs.hasBubble) return 'bubble';
  return 'collapsed';
}

function deriveIntent(inputs: GeometryInputs): PetGeometryIntent {
  const { config } = inputs;
  const anchor =
    config.defaultPosition === 'lastDragged' && config.lastPosition
      ? { x: config.lastPosition.x, y: config.lastPosition.y }
      : null;
  return {
    visual: deriveVisual(inputs),
    size: config.size,
    anchor,
    corner: config.defaultPosition === 'leftBottom' ? 'leftBottom' : 'rightBottom',
  };
}

/**
 * Single client for the Rust geometry authority. Derives the finite
 * `PetVisual`, issues coalesced `pet_apply_geometry` invocations ("latest
 * intent wins" while a call is in flight — the Rust mutex serialises across
 * callers), debounces *shrink* transitions by 120ms so bursty notifications
 * don't thrash the window, and exposes the resolved layout from
 * `pet://geometry` for absolute positioning inside the window.
 */
export function usePetGeometry(inputs: GeometryInputs): {
  geometry: PetGeometry | null;
  visual: PetVisual;
} {
  const [geometry, setGeometry] = useState<PetGeometry | null>(null);
  const visual = deriveVisual(inputs);

  const inFlightRef = useRef(false);
  const pendingRef = useRef<PetGeometryIntent | null>(null);
  const appliedVisualRef = useRef<PetVisual>('collapsed');
  const retractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const intent = useMemo(
    () => deriveIntent(inputs),
    // Only the fields that affect geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      inputs.enabled,
      inputs.expanded,
      inputs.hasBubble,
      inputs.config.size,
      inputs.config.defaultPosition,
      inputs.config.lastPosition?.x,
      inputs.config.lastPosition?.y,
    ],
  );

  // Listen for the authoritative resolved geometry.
  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;
    let off: UnlistenFn | null = null;
    (async () => {
      off = await listen<PetGeometry>('pet://geometry', (event) => {
        if (!cancelled && event.payload) {
          setGeometry(event.payload);
        }
      });
      if (cancelled && off) off();
    })();
    return () => {
      cancelled = true;
      if (off) off();
    };
  }, []);

  // Drive geometry from the derived intent.
  useEffect(() => {
    if (!isTauriEnv() || !inputs.enabled) return;

    const send = (next: PetGeometryIntent) => {
      if (inFlightRef.current) {
        pendingRef.current = next;
        return;
      }
      inFlightRef.current = true;
      void invoke<PetGeometry>('pet_apply_geometry', { intent: next })
        .then((geom) => {
          appliedVisualRef.current = next.visual;
          if (geom) setGeometry(geom);
        })
        .catch((err) => {
          // Surface the failure instead of hiding it: when this command
          // fails the window never grows and the bubble/panel stays clipped
          // by the 96px OS window. The backend still retries on the next
          // intent change, but the operator needs to see the root cause.
          console.error('[pet] pet_apply_geometry failed', err);
        })
        .finally(() => {
          inFlightRef.current = false;
          if (pendingRef.current) {
            const queued = pendingRef.current;
            pendingRef.current = null;
            send(queued);
          }
        });
    };

    if (retractTimerRef.current) {
      clearTimeout(retractTimerRef.current);
      retractTimerRef.current = null;
    }

    const isShrink = VISUAL_RANK[intent.visual] < VISUAL_RANK[appliedVisualRef.current];
    if (isShrink) {
      retractTimerRef.current = setTimeout(() => {
        retractTimerRef.current = null;
        send(intent);
      }, RETRACT_DEBOUNCE_MS);
    } else {
      send(intent);
    }

    return () => {
      if (retractTimerRef.current) {
        clearTimeout(retractTimerRef.current);
        retractTimerRef.current = null;
      }
    };
  }, [intent, inputs.enabled]);

  return { geometry, visual };
}
