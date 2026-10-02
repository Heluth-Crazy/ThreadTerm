import type { Session } from "@threadterm/protocol";

/** The five presentation states of the prototype (dots, pills, `--st-*` tokens). */
export type SessionViewState = "needs" | "running" | "failed" | "ended" | "stalled";

export function sessionState(session: Pick<Session, "status" | "readOnly">): SessionViewState {
  if (session.readOnly) return "ended";
  switch (session.status) {
    case "waiting": return "needs";
    case "error": return "failed";
    case "interrupted": return "stalled";
    case "exited": return "ended";
    default: return "running";
  }
}

const labels: Record<"en" | "zh", Record<SessionViewState, string>> = {
  en: { needs: "Needs you", running: "Running", failed: "Failed", ended: "Ended", stalled: "Stalled" },
  zh: { needs: "需要你", running: "运行中", failed: "失败", ended: "已结束", stalled: "停滞" },
};

/** One wording for a state everywhere (pills, tooltips, summaries); read-only records say so. */
export function sessionStateLabel(state: SessionViewState, zh: boolean, readOnly = false): string {
  if (readOnly) return zh ? "只读" : "Read-only";
  return labels[zh ? "zh" : "en"][state];
}
