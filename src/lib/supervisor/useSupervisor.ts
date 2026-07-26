/**
 * useSupervisor — React glue for AI Supervisor v0.1.
 *
 * Responsibilities:
 *   1. Mirror `(supervisorEnabled, pinnedCardIds)` from `terminalStore` into
 *      the Rust backend via `supervisor_enable`. The Rust side is the only
 *      thing that actually matches regex / fires alerts (PRD R1).
 *   2. Subscribe once to the `supervisor://alert` event, push hits into the
 *      `supervisorStore` (with frontend dedup) and surface them in the
 *      Notification Centre via `pushNotification` — which automatically
 *      triggers an OS notification through `NotificationBridge` (R5).
 *   3. On unmount: tear down the listener and tell the backend to disable.
 *
 * Place this hook in the React tree exactly once (e.g. inside `App.tsx` next
 * to `NotificationBridge`). It does not render anything.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  invokeSupervisorEnable,
  subscribeSupervisorAlert,
  type SupervisorAlertPayload,
} from '../tauri-bridge';
import {
  buildInteractionEpisodeKey,
  normalizeNotificationFingerprint,
} from '../osNotificationPolicy';
import { useTerminalStore } from '../../stores/terminalStore';
import { useSupervisorStore } from './supervisorStore';
import { isSupervisorRuleId } from './rules';

/**
 * Subscribe to terminalStore + the backend alert stream. Idempotent — render
 * once per app and the hook handles its own cleanup.
 */
export function useSupervisor(): void {
  const { t } = useTranslation('supervisor');

  const supervisorEnabled = useTerminalStore((s) => s.supervisorEnabled);
  const pinnedCardIds = useTerminalStore((s) => s.pinnedCardIds);
  const pushNotification = useTerminalStore((s) => s.pushNotification);

  // Stable refs so the alert-listener effect doesn't re-subscribe each
  // render — listen() is async-expensive and we only want one subscription.
  const pushNotificationRef = useRef(pushNotification);
  const tRef = useRef(t);
  useEffect(() => {
    pushNotificationRef.current = pushNotification;
  }, [pushNotification]);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // Effect 1 — sync the (enabled, watched) tuple to the backend whenever
  // either side changes. Runs on mount with the initial values too.
  useEffect(() => {
    const watchedCardIds = supervisorEnabled ? [...pinnedCardIds] : [];
    invokeSupervisorEnable(supervisorEnabled, watchedCardIds).catch(() => {
      // Best-effort: in non-Tauri (web) env or before init, the command may
      // not exist — that's fine, the hook is still safe to mount.
    });
  }, [supervisorEnabled, pinnedCardIds]);

  // Effect 2 — single subscription to supervisor://alert for the app's
  // lifetime. Mount once, unsubscribe on unmount.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const handleAlert = (payload: SupervisorAlertPayload): void => {
      if (!payload || !isSupervisorRuleId(payload.ruleId)) return;

      const terminalState = useTerminalStore.getState();
      const card = terminalState.cards.find(
        (candidate) => candidate.id === payload.cardId,
      );
      const generation = card?.messageCount ?? 0;
      const fingerprint = normalizeNotificationFingerprint(
        `${payload.ruleId}:${payload.sampleText}`,
      );
      const alert = useSupervisorStore.getState().ingestAlert({
        cardId: payload.cardId,
        ruleId: payload.ruleId,
        sampleText: payload.sampleText,
        ts: payload.ts,
        generation,
      });
      if (!alert) return; // Frontend dedup window swallowed it.

      const titleKey = `alertTitle.${payload.ruleId}`;
      const bodyKey = `alertBody.${payload.ruleId}`;
      const entry = pushNotificationRef.current({
        cardId: payload.cardId,
        kind: 'attention',
        title: tRef.current(titleKey, { defaultValue: titleKey }),
        body: tRef.current(bodyKey, {
          defaultValue: payload.sampleText,
          sampleText: payload.sampleText,
        }),
        at: payload.ts,
        routing: {
          origin: 'supervisor',
          family: 'interaction',
          episodeKey: buildInteractionEpisodeKey(payload.cardId, generation),
          fingerprint,
        },
      });
      useSupervisorStore.getState().attachNotification(alert.id, entry.id);
    };

    subscribeSupervisorAlert(handleAlert)
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
      })
      .catch(() => {
        // Non-Tauri env or backend missing — silent fallback.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Effect 3 — explicit shutdown on unmount so a hot-reload or app teardown
  // doesn't leave the backend in an "enabled" state for ghost watchers.
  useEffect(() => {
    return () => {
      invokeSupervisorEnable(false, []).catch(() => {
        /* ignore — same reason as effect 1 */
      });
    };
  }, []);
}
