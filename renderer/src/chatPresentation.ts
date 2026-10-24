import type { ChatItem, ChatPart } from "@threadterm/protocol";
import { browserToolActivityFromPart, browserToolIdentity, hasRedactedBrowserResult } from "./browserToolActivity";

export function partBody(part: ChatPart): string {
  if (hasRedactedBrowserResult(part)) {
    const activity = browserToolActivityFromPart(part);
    return activity ? JSON.stringify(activity, null, 2) : "";
  }
  if (typeof part.text === "string") return part.text;
  if (typeof part.data === "string") return part.data;
  if (part.data == null) return "";
  return JSON.stringify(part.data, null, 2);
}

export function formatChatDuration(ms: number, zh: boolean): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return zh ? `用时 ${seconds}s` : `${seconds}s`;
  return zh ? `用时 ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

export function shouldRenderPart(part: ChatPart): boolean {
  if (part.type === "usage") return false;
  // Plan parts are shown by the pinned ChatPlanPanel, never inline.
  if (part.type === "plan") return false;
  if (part.type === "text") return Boolean(part.text);
  if (part.type === "thinking") return Boolean(part.text) || part.status === "streaming";
  return true;
}

export function partLabel(part: ChatPart, copy: (en: string, zh: string) => string): string | undefined {
  if (part.type === "text" || part.type === "usage" || part.type === "thinking" || part.type === "status") return undefined;
  if (part.type === "tool") {
    if (hasRedactedBrowserResult(part)) return browserToolIdentity(part).displayTool ?? copy("Browser tool", "浏览器工具");
    return part.toolName || copy("Tool", "工具");
  }
  if (part.type === "approval") return copy("Approval required", "需要批准");
  if (part.type === "error") return copy("Error", "错误");
  return part.type;
}

export function chatCanControl(session: { readOnly?: boolean; status: string }): boolean {
  return !session.readOnly && session.status !== "exited";
}

/** An explicit native outcome wins over legacy duration-only completion. */
function turnIsSettled(items: readonly ChatItem[]): boolean {
  const status = [...items].reverse().find(item => item.turnStatus)?.turnStatus;
  return status ? settledStatus(status) : items.some(item => item.elapsedMs != null);
}

const settledStatus = (status: ChatItem['turnStatus']): boolean => status === 'completed' || status === 'failed' || status === 'interrupted';
const inFlightPart = (part: ChatPart): boolean => part.status === 'streaming' || part.status === 'running' || (part.type === 'approval' && part.status === 'pending');

interface TurnFacts { lastStatus?: ChatItem['turnStatus']; elapsed: boolean; inFlight: boolean }
export interface TurnOutcome { completed: boolean; notCompleted: boolean }

/** Turn settlement, liveness and grouping facts a transcript pass needs, keyed by turn id. */
export interface ChatPresentationIndex {
  readonly items: readonly ChatItem[];
  /** First live (non-history) position per item id. */
  readonly liveIndexById: ReadonlyMap<string, number>;
  readonly turns: ReadonlyMap<string, TurnFacts>;
  /** Native outcome of every turn, imported history included (fork eligibility). */
  readonly outcomes: ReadonlyMap<string, TurnOutcome>;
  readonly lastUserIndex: number;
  readonly lastAssistantIndex: number;
  readonly lastTurnItem: ChatItem | undefined;
}

/**
 * One linear pass over a transcript revision. Per-item presentation lookups are
 * then O(1) instead of rescanning the whole history for every item.
 */
export function chatPresentationIndex(items: readonly ChatItem[]): ChatPresentationIndex {
  const liveIndexById = new Map<string, number>(), turns = new Map<string, TurnFacts>(), outcomes = new Map<string, TurnOutcome>();
  let lastUserIndex = -1, lastAssistantIndex = -1, lastTurnItem: ChatItem | undefined;
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position]!;
    if (item.turnId && item.turnStatus) {
      let outcome = outcomes.get(item.turnId);
      if (!outcome) { outcome = { completed: false, notCompleted: false }; outcomes.set(item.turnId, outcome); }
      if (item.turnStatus === 'completed') outcome.completed = true;
      else outcome.notCompleted = true;
    }
    if (item.turnOrigin === 'history') continue;
    if (!liveIndexById.has(item.id)) liveIndexById.set(item.id, position);
    if (item.role === 'user') lastUserIndex = position;
    else if (item.role === 'assistant') lastAssistantIndex = position;
    if (!item.turnId) continue;
    lastTurnItem = item;
    let turn = turns.get(item.turnId);
    if (!turn) { turn = { elapsed: false, inFlight: false }; turns.set(item.turnId, turn); }
    if (item.turnStatus) turn.lastStatus = item.turnStatus;
    if (item.elapsedMs != null) turn.elapsed = true;
    if (!turn.inFlight && item.parts.some(inFlightPart)) turn.inFlight = true;
  }
  return { items, liveIndexById, turns, outcomes, lastUserIndex, lastAssistantIndex, lastTurnItem };
}

const turnFactsSettled = (turn: TurnFacts): boolean => turn.lastStatus ? settledStatus(turn.lastStatus) : turn.elapsed;
const presentationIndex = (source: ChatItem[] | ChatPresentationIndex): ChatPresentationIndex => Array.isArray(source) ? chatPresentationIndex(source) : source;

export function itemShowsStreaming(item: ChatItem, source: ChatItem[] | ChatPresentationIndex): boolean {
  if (item.turnOrigin === 'history') return false;
  const index = presentationIndex(source);
  const settled = item.turnId ? turnFactsSettled(index.turns.get(item.turnId) ?? { elapsed: false, inFlight: false }) : turnIsSettled([item]);
  if (settled) return false;
  const position = index.liveIndexById.get(item.id);
  if (position === undefined || position !== index.lastAssistantIndex) return false;
  if (index.lastUserIndex >= 0 && index.lastAssistantIndex < index.lastUserIndex) return false;
  return item.parts.some((part) => part.status === "streaming" || part.status === "running");
}

export function slashQuery(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  if (text.includes("\n") || text.includes(" ")) return undefined;
  return text.slice(1).toLowerCase();
}

export function matchSlashCommands(query: string, commands: { name: string; description?: string }[]): { name: string; description?: string }[] {
  const needle = query.replace(/^\//, "").toLowerCase();
  return commands.filter((command) => command.name.replace(/^\//, "").toLowerCase().startsWith(needle));
}

export function activeTurnId(items: ChatItem[], sessionStatus?: string): string | undefined {
  return activeTurnIdFromIndex(chatPresentationIndex(items), sessionStatus);
}

export function activeTurnIdFromIndex(index: ChatPresentationIndex, sessionStatus?: string): string | undefined {
  // Persisted native parts can retain streaming flags after reload. Only the
  // runtime's current running/waiting state can authorize a stop action.
  if (sessionStatus !== undefined && sessionStatus !== 'running' && sessionStatus !== 'waiting') return undefined;
  const turnId = index.lastTurnItem?.turnId;
  if (!turnId) return undefined;
  const turn = index.turns.get(turnId);
  if (!turn || turnFactsSettled(turn)) return undefined;
  if (sessionStatus !== undefined) return turnId;
  return turn.inFlight ? turnId : undefined;
}
