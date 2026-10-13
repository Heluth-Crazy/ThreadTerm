import { useEffect, useState } from "react";
import type { ChatContextUsage } from "@threadterm/protocol";
import { request, subscribeEvents } from "./bridge";
import { observeContextUsage } from "./contextUsage";

export function useChatContextUsage(sessionId: string): ChatContextUsage | undefined {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; usage?: ChatContextUsage }>();
  useEffect(() => observeContextUsage(
    sessionId,
    () => request("chat.context.read", { sessionId }),
    subscribeEvents,
    usage => setSnapshot({ sessionId, usage }),
  ), [sessionId]);
  return snapshot?.sessionId === sessionId ? snapshot.usage : undefined;
}
