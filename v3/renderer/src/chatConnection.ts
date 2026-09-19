import type { ChatConnectionPhase, ChatConnectionState } from "@threadterm/protocol";

export type ChatOverlayKind = "none" | "full" | "banner";
export type TransportStatus = "up" | "down" | "syncing";

export interface ChatLinkState {
  connection: ChatConnectionState;
  transport: TransportStatus;
  transportGeneration: number;
}

export type ChatLinkAction =
  | { type: "reset"; sessionId: string; phase: ChatConnectionPhase }
  | { type: "snapshot"; snapshot: ChatConnectionState; transportGeneration?: number; resync?: boolean }
  | { type: "event"; snapshot: ChatConnectionState; epoch: string }
  | { type: "connect-failed"; message: string }
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
): ChatConnectionState | null {
  if (next.sessionId !== current.sessionId) return null;
  const incomingEpoch = next.runtimeEpoch || runtimeEpoch;
  if (current.runtimeEpoch && incomingEpoch && incomingEpoch !== current.runtimeEpoch) return null;
  if (next.connectionGeneration < current.connectionGeneration) return null;
  if (next.connectionGeneration === current.connectionGeneration && next.revision < current.revision) return null;
  return { ...next, runtimeEpoch: incomingEpoch || current.runtimeEpoch };
}

export function mergeConnectionSnapshot(current: ChatConnectionState, next: ChatConnectionState): ChatConnectionState {
  return applyConnectionEvent(current, next, next.runtimeEpoch) ?? current;
}

export function mergeConnectionEvent(current: ChatConnectionState, next: ChatConnectionState, eventEpoch: string): ChatConnectionState {
  return applyConnectionEvent(current, next, eventEpoch) ?? current;
}

export function reduceChatLink(state: ChatLinkState, action: ChatLinkAction): ChatLinkState {
  switch (action.type) {
    case "reset":
      return emptyLink(action.sessionId, action.phase);
    case "snapshot": {
      if (action.transportGeneration !== undefined && action.transportGeneration !== state.transportGeneration) return state;
      if (state.transport === "down") return state;
      if (state.transport === "syncing") {
        if (!action.resync || action.transportGeneration !== state.transportGeneration
          || action.snapshot.sessionId !== state.connection.sessionId
          || action.snapshot.runtimeEpoch !== state.connection.runtimeEpoch) return state;
        // This query was issued after this pipe reconnected. Its generation may
        // legitimately reset after a daemon restart, even with the same DB.
        return { ...state, connection: action.snapshot, transport: "up" };
      }
      return { ...state, connection: mergeConnectionSnapshot(state.connection, action.snapshot) };
    }
    case "event":
      if (state.transport !== "up") return state;
      return { ...state, connection: mergeConnectionEvent(state.connection, action.snapshot, action.epoch) };
    case "connect-failed":
      return {
        ...state,
        connection: {
          ...state.connection,
          phase: "failed",
          revision: state.connection.revision + 1,
          error: { code: "connect_failed", message: action.message, retryable: true, category: "runtime" },
        },
      };
    case "transport-down":
      return { ...state, transport: "down", transportGeneration: state.transportGeneration + 1 };
    case "transport-up": {
      const epoch = action.epoch || state.connection.runtimeEpoch;
      const epochChanged = Boolean(state.connection.runtimeEpoch && epoch && epoch !== state.connection.runtimeEpoch);
      const base = epochChanged
        ? { ...state.connection, runtimeEpoch: epoch, connectionGeneration: 0, revision: 0 }
        : { ...state.connection, runtimeEpoch: epoch };
      const connection = action.snapshot
        ? mergeConnectionSnapshot(base, { ...action.snapshot, runtimeEpoch: action.snapshot.runtimeEpoch || epoch })
        : base;
      const synced = action.snapshot?.sessionId === base.sessionId && action.snapshot.runtimeEpoch === epoch;
      return { connection, transport: synced ? "up" : "syncing", transportGeneration: state.transportGeneration + 1 };
    }
  }
}

export function connectionStatusText(
  provider: string,
  phase: ChatConnectionPhase,
  copy: (en: string, zh: string) => string,
  transportDown = false,
): string {
  if (transportDown) return copy("Runtime connection lost. Messages stay readable; writes wait until the pipe returns.", "与运行时的连接已断开。消息仍可阅读，恢复前不能写入。");
  const name = providerLabel(provider);
  if (phase === "failed") return copy(`Could not connect to ${name}.`, `无法连接到 ${name}。`);
  if (phase === "disconnected") return copy(`Reconnecting to ${name}…`, `正在重新连接 ${name}…`);
  return copy(`Connecting to ${name}…`, `正在连接 ${name}…`);
}

export function providerLabel(provider: string): string {
  const name = provider.toLowerCase();
  if (name === "kimi") return "Kimi";
  if (name === "codex") return "Codex";
  if (name === "grok") return "Grok";
  if (name === "claude") return "Claude";
  if (name === "gemini") return "Gemini";
  if (name === "opencode") return "OpenCode";
  return provider;
}
