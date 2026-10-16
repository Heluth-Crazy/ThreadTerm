import { agentName } from "./agents";
import type { ChatConnectionPhase, ChatConnectionState, ProviderCapability } from "@threadterm/protocol";

export type ChatOverlayKind = "none" | "full" | "banner";
export type TransportStatus = "up" | "down" | "syncing";

export interface ChatConnectAttempt {
  sessionId: string;
  runtimeEpoch: string;
  connectionGeneration: number;
  transportGeneration: number;
}

export interface ChatLinkState {
  connection: ChatConnectionState;
  transport: TransportStatus;
  transportGeneration: number;
  failedAttempt?: ChatConnectAttempt;
}

export type ChatLinkAction =
  | { type: "reset"; sessionId: string; phase: ChatConnectionPhase }
  | { type: "snapshot"; snapshot: ChatConnectionState; transportGeneration?: number; resync?: boolean; attempt?: ChatConnectAttempt }
  | { type: "event"; snapshot: ChatConnectionState; epoch: string }
  | { type: "connect-failed"; message: string; attempt?: ChatConnectAttempt }
  | { type: "transport-down" }
  | { type: "transport-up"; epoch: string; snapshot?: ChatConnectionState };

export function emptyConnection(sessionId: string, phase: ChatConnectionPhase = "disconnected"): ChatConnectionState {
  return {
    sessionId,
    runtimeEpoch: "",
    connectionGeneration: 0,
    revision: 0,
    phase,
    optionsLoadState: "unknown",
  };
}

export function emptyLink(sessionId: string, phase: ChatConnectionPhase = "disconnected"): ChatLinkState {
  return { connection: emptyConnection(sessionId, phase), transport: "up", transportGeneration: 0 };
}

export function isLiveConnection(phase: ChatConnectionPhase): boolean {
  return phase === "ready";
}

/** A reconnect overlay means a disconnected provider is pending, not idle.
 * Keep the authoritative phase unchanged for connection and write guards. */
export function connectionFeedbackPhase(phase: ChatConnectionPhase, overlay: ChatOverlayKind): ChatConnectionPhase {
  return phase === "disconnected" && overlay !== "none" ? "connecting" : phase;
}

export function overlayKind(input: {
  ended: boolean;
  canControl: boolean;
  phase: ChatConnectionPhase;
  hasTranscript: boolean;
  transportDown?: boolean;
}): ChatOverlayKind {
  if (input.ended || !input.canControl) return "none";
  if (input.transportDown) return input.hasTranscript || input.phase === "ready" ? "banner" : "full";
  if (input.phase === "ready" || input.phase === "unavailable") return "none";
  const reconnecting = input.phase === "connecting" || input.phase === "disconnected" || input.phase === "failed";
  if (!reconnecting) return "none";
  if (input.hasTranscript) return "banner";
  return "full";
}

export function applyConnectionEvent(
  current: ChatConnectionState,
  next: ChatConnectionState,
  runtimeEpoch: string,
  failedAttempt?: ChatConnectAttempt,
): ChatConnectionState | null {
  if (next.sessionId !== current.sessionId) return null;
  const incomingEpoch = next.runtimeEpoch || runtimeEpoch;
  if (current.runtimeEpoch && incomingEpoch && incomingEpoch !== current.runtimeEpoch) return null;
  if (next.connectionGeneration < current.connectionGeneration) return null;
  if (next.connectionGeneration === current.connectionGeneration && next.revision < current.revision) return null;
  // A rejected request can precede its queued connecting event. Retire that
  // attempt's generation without advancing the authoritative runtime revision.
  if (failedAttempt && (!failedAttempt.runtimeEpoch || failedAttempt.runtimeEpoch === incomingEpoch)
    && next.connectionGeneration <= failedAttempt.connectionGeneration
    && (next.phase !== "failed" || current.phase !== "failed")) return null;
  if (current.phase === "failed" && next.connectionGeneration === current.connectionGeneration && next.phase !== "failed") return null;
  return { ...next, error: next.phase === "failed" ? next.error : undefined, runtimeEpoch: incomingEpoch || current.runtimeEpoch };
}

export function mergeConnectionSnapshot(current: ChatConnectionState, next: ChatConnectionState, failedAttempt?: ChatConnectAttempt): ChatConnectionState {
  return applyConnectionEvent(current, next, next.runtimeEpoch, failedAttempt) ?? current;
}

export function mergeConnectionEvent(current: ChatConnectionState, next: ChatConnectionState, eventEpoch: string, failedAttempt?: ChatConnectAttempt): ChatConnectionState {
  return applyConnectionEvent(current, next, eventEpoch, failedAttempt) ?? current;
}

export function reduceChatLink(state: ChatLinkState, action: ChatLinkAction): ChatLinkState {
  switch (action.type) {
    case "reset":
      return action.sessionId === state.connection.sessionId
        ? { ...state, connection: { ...state.connection, phase: action.phase, error: undefined } }
        : emptyLink(action.sessionId, action.phase);
    case "snapshot": {
      if (action.transportGeneration !== undefined && action.transportGeneration !== state.transportGeneration) return state;
      if (state.transport === "down") return state;
      if (state.transport === "syncing") {
        if (!action.resync || action.transportGeneration !== state.transportGeneration
          || action.snapshot.sessionId !== state.connection.sessionId
          || action.snapshot.runtimeEpoch !== state.connection.runtimeEpoch) return state;
        // This query was issued after this pipe reconnected. Its generation may
        // legitimately reset after a daemon restart, even with the same DB.
        return { ...state, connection: action.snapshot, failedAttempt: undefined, transport: "up" };
      }
      // A successful explicit request may confirm an already-live worker without
      // allocating a generation (for example after an earlier admission error).
      const connection = mergeConnectionSnapshot(state.connection, action.snapshot, action.attempt ? undefined : state.failedAttempt);
      return { ...state, connection, failedAttempt: action.attempt && connection !== state.connection ? undefined : state.failedAttempt };
    }
    case "event":
      if (state.transport !== "up") return state;
      return { ...state, connection: mergeConnectionEvent(state.connection, action.snapshot, action.epoch, state.failedAttempt) };
    case "connect-failed": {
      const attempt = action.attempt ?? { ...state.connection, transportGeneration: state.transportGeneration };
      if (attempt.sessionId !== state.connection.sessionId || attempt.transportGeneration !== state.transportGeneration
        || state.transport !== "up" || (attempt.runtimeEpoch && state.connection.runtimeEpoch && attempt.runtimeEpoch !== state.connection.runtimeEpoch)
        || state.connection.connectionGeneration > attempt.connectionGeneration) return state;
      return {
        ...state,
        connection: {
          ...state.connection,
          phase: "failed",
          error: { code: "connect_failed", message: action.message, retryable: true, category: "runtime" },
        },
        failedAttempt: attempt,
      };
    }
    case "transport-down":
      return { ...state, transport: "down", transportGeneration: state.transportGeneration + 1 };
    case "transport-up": {
      const epoch = action.epoch || state.connection.runtimeEpoch;
      const epochChanged = Boolean(epoch && epoch !== state.connection.runtimeEpoch);
      const base = epochChanged
        ? { ...emptyConnection(state.connection.sessionId), runtimeEpoch: epoch }
        : { ...state.connection, runtimeEpoch: epoch };
      const connection = action.snapshot
        ? mergeConnectionSnapshot(base, { ...action.snapshot, runtimeEpoch: action.snapshot.runtimeEpoch || epoch })
        : base;
      const synced = action.snapshot?.sessionId === base.sessionId && action.snapshot.runtimeEpoch === epoch;
      return { connection, failedAttempt: epochChanged || synced ? undefined : state.failedAttempt, transport: synced ? "up" : "syncing", transportGeneration: state.transportGeneration + 1 };
    }
  }
}

export function connectionStatusText(
  provider: string,
  phase: ChatConnectionPhase,
  copy: (en: string, zh: string) => string,
  transportDown = false,
  capabilities: readonly ProviderCapability[] = [],
): string {
  if (transportDown) return copy("Runtime connection lost. Messages stay readable; writes wait until the pipe returns.", "与运行时的连接已断开。消息仍可阅读，恢复前不能写入。");
  const name = providerLabel(provider, capabilities);
  if (phase === "failed") return copy(`Could not connect to ${name}.`, `无法连接到 ${name}。`);
  if (phase === "disconnected") return copy(`Reconnecting to ${name}…`, `正在重新连接 ${name}…`);
  return copy(`Connecting to ${name}…`, `正在连接 ${name}…`);
}

export function providerLabel(provider: string, capabilities: readonly ProviderCapability[] = []): string {
  return agentName(provider, capabilities);
}
