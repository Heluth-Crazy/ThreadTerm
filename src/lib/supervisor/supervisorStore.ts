/**
 * supervisorStore — non-persist Zustand slice for AI Supervisor v0.1.
 *
 * Per PRD D7: alerts and telemetry counts live in memory only; restart
 * clears everything so MVP value-validation isn't polluted by historical
 * data. SQLite persistence is a v0.2 concern.
 *
 * Responsibilities:
 *   • De-duplicate `(cardId, ruleId)` within a 60s window (belt-and-braces
 *     over the backend's identical guard — PRD D6).
 *   • Track three telemetry counters (triggered / clicked / acted — D10).
 *   • Cap the alerts queue at 50 entries to bound memory in long sessions.
 *
 * Non-responsibilities:
 *   • No regex matching — backend is authoritative (PRD D12 implementation).
 *   • No notification dispatch — that's `useSupervisor`'s job; this store is
 *     pure data + actions, no React.
 */
import { create } from 'zustand';

import type { SupervisorRuleId } from './rules';

/** Frontend mirror of the backend `AlertPayload` plus click bookkeeping. */
export interface SupervisorAlert {
  /** Locally-generated id; the backend payload has no id of its own. */
  id: string;
  cardId: string;
  ruleId: SupervisorRuleId;
  /** ANSI-stripped tail sample lifted from the matching buffer. */
  sampleText: string;
  /** Unix epoch milliseconds at which the backend fired the event. */
  ts: number;
  clicked: boolean;
  /** Epoch ms when the user clicked the corresponding notification. */
  clickedAt: number | null;
  /** Whether this alert has already credited one follow-up pty.write. */
  acted: boolean;
  /** Epoch ms when the first eligible pty.write after click was observed. */
  actedAt: number | null;
  /** id of the `NotificationEntry` this alert pushed into terminalStore. */
  notificationId: string | null;
}

export interface SupervisorTelemetry {
  triggered: number;
  clicked: number;
  acted: number;
}

export interface SupervisorAlertInput {
  cardId: string;
  ruleId: SupervisorRuleId;
  sampleText: string;
  ts: number;
}

interface SupervisorState {
  alerts: SupervisorAlert[];
  telemetry: SupervisorTelemetry;
  ingestAlert: (payload: SupervisorAlertInput) => SupervisorAlert | null;
  attachNotification: (alertId: string, notificationId: string) => void;
  recordClick: (alertId: string) => void;
  /**
   * Mark the most recent unclicked alert for `cardId` as clicked. Used by the
   * notification click paths (Notification Centre + OS notification onAction)
   * which only know the cardId, not the supervisor alertId. Returns `true` if
   * an alert was credited, `false` if nothing matched.
   */
  recordClickByCardId: (cardId: string) => boolean;
  recordAction: (cardId: string) => void;
  resetTelemetry: () => void;
  clearAlerts: () => void;
}

/** Same window as the backend cooldown (PRD D6). Exposed for tests. */
export const SUPERVISOR_DEDUP_WINDOW_MS = 60_000;
/** Window in which a `pty.write` after a click counts as `acted` (PRD D10). */
export const SUPERVISOR_ACTION_WINDOW_MS = 60_000;
/** FIFO cap on the in-memory alert queue. */
export const SUPERVISOR_ALERTS_MAX = 50;

const INITIAL_TELEMETRY: SupervisorTelemetry = {
  triggered: 0,
  clicked: 0,
  acted: 0,
};

function makeAlertId(): string {
  // Uses crypto.randomUUID when available (Node ≥ 18 / modern browsers);
  // falls back to a time + random hex string for legacy test environments.
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `sup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useSupervisorStore = create<SupervisorState>((set, get) => ({
  alerts: [],
  telemetry: { ...INITIAL_TELEMETRY },

  ingestAlert: (payload) => {
    const { alerts } = get();
    // Dedup window — backend already filters but we double-check to stay
    // resilient against duplicate IPC events (e.g. listener attached twice
    // during HMR).
    const isDuplicate = alerts.some(
      (a) =>
        a.cardId === payload.cardId &&
        a.ruleId === payload.ruleId &&
        payload.ts - a.ts < SUPERVISOR_DEDUP_WINDOW_MS,
    );
    if (isDuplicate) return null;

    const next: SupervisorAlert = {
      id: makeAlertId(),
      cardId: payload.cardId,
      ruleId: payload.ruleId,
      sampleText: payload.sampleText,
      ts: payload.ts,
      clicked: false,
      clickedAt: null,
      acted: false,
      actedAt: null,
      notificationId: null,
    };

    set((state) => {
      const queue = [...state.alerts, next];
      if (queue.length > SUPERVISOR_ALERTS_MAX) {
        queue.splice(0, queue.length - SUPERVISOR_ALERTS_MAX);
      }
      return {
        alerts: queue,
        telemetry: { ...state.telemetry, triggered: state.telemetry.triggered + 1 },
      };
    });
    return next;
  },

  attachNotification: (alertId, notificationId) =>
    set((state) => {
      const idx = state.alerts.findIndex((a) => a.id === alertId);
      if (idx === -1) return state;
      const alerts = [...state.alerts];
      alerts[idx] = { ...alerts[idx], notificationId };
      return { alerts };
    }),

  recordClick: (alertId) =>
    set((state) => {
      const idx = state.alerts.findIndex((a) => a.id === alertId);
      if (idx === -1) return state;
      // Idempotent: clicking the same notification twice still counts once
      // toward the click telemetry so the click-through ratio stays honest.
      if (state.alerts[idx].clicked) return state;
      const alerts = [...state.alerts];
      alerts[idx] = { ...alerts[idx], clicked: true, clickedAt: Date.now() };
      return {
        alerts,
        telemetry: { ...state.telemetry, clicked: state.telemetry.clicked + 1 },
      };
    }),

  recordClickByCardId: (cardId) => {
    let credited = false;
    set((state) => {
      // Find the newest unclicked alert for this card. Iterating in reverse
      // because the queue is FIFO (oldest first), so the latest alert is at
      // the tail.
      let targetIdx = -1;
      for (let i = state.alerts.length - 1; i >= 0; i -= 1) {
        const candidate = state.alerts[i];
        if (candidate.cardId === cardId && !candidate.clicked) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) return state;
      const alerts = [...state.alerts];
      alerts[targetIdx] = {
        ...alerts[targetIdx],
        clicked: true,
        clickedAt: Date.now(),
      };
      credited = true;
      return {
        alerts,
        telemetry: { ...state.telemetry, clicked: state.telemetry.clicked + 1 },
      };
    });
    return credited;
  },

  recordAction: (cardId) =>
    set((state) => {
      const now = Date.now();
      let targetIdx = -1;
      for (let i = state.alerts.length - 1; i >= 0; i -= 1) {
        const candidate = state.alerts[i];
        if (
          candidate.cardId === cardId &&
          candidate.clicked &&
          !candidate.acted &&
          candidate.clickedAt !== null &&
          now - candidate.clickedAt <= SUPERVISOR_ACTION_WINDOW_MS
        ) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) return state;
      const alerts = [...state.alerts];
      alerts[targetIdx] = { ...alerts[targetIdx], acted: true, actedAt: now };
      return {
        alerts,
        telemetry: { ...state.telemetry, acted: state.telemetry.acted + 1 },
      };
    }),

  resetTelemetry: () => set({ telemetry: { ...INITIAL_TELEMETRY } }),

  clearAlerts: () => set({ alerts: [] }),
}));
