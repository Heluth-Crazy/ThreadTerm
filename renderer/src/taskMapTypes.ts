import type { ChatItem, Session, SessionDocument, SubagentInfo } from '@threadterm/protocol';

/** Task map (task 10-21-task-map): a Chat task's lifecycle as lanes × turns, shown as a vertical flow. Design: .trellis/tasks/10-21-task-map/design.md */

export type TaskMapStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type TaskMapLaneKind = 'agent' | 'delegate' | 'subagent' | 'outputs';

export interface TaskMapLane {
  /** `agent:<sessionId>`, `subagent:<sessionId>:<key>` or `outputs`. */
  id: string;
  kind: TaskMapLaneKind;
  /** The Chat whose items feed this lane (the parent Chat for a native subagent); absent for outputs. */
  sessionId?: string;
  /** Provider id of the session, or `SubagentInfo.provider` for a native subagent. */
  provider?: string;
  title: string;
  /** Delegate branch, subagent type, … */
  subtitle?: string;
  /** 0 for the root and outputs lanes, parent depth + 1 below it. */
  depth: number;
  parentLaneId?: string;
  status?: TaskMapStatus;
}

export type TaskMapStepKind = 'explore' | 'command' | 'edit' | 'browser' | 'mcp' | 'delegation' | 'tool';
export type TaskMapNodeKind = 'prompt' | 'plan' | 'tools' | 'delegate' | 'subagent' | 'approval' | 'question' | 'error' | 'reply' | 'files' | 'document';

/** One chat part a node stands for. */
export interface TaskMapPartRef { itemId: string; partIndex: number }

export interface TaskMapNode {
  /** Stable across rebuilds: `<laneId>:<first itemId>:<first partIndex>` (outputs: `outputs:<source>`). */
  id: string;
  laneId: string;
  kind: TaskMapNodeKind;
  /** Set for `tools` nodes. */
  step?: TaskMapStepKind;
  label: string;
  detail?: string;
  status: TaskMapStatus;
  /** Index into `TaskMapGraph.phases`. */
  phase: number;
  /** Epoch ms of the first item it covers, when known. */
  at?: number;
  /** Position within its lane (0-based, increasing). */
  sequence: number;
  /** The Chat whose items `parts` refer to. */
  sessionId?: string;
  parts: TaskMapPartRef[];
  /** Calls in a group, files in a files node. */
  count?: number;
  /** `delegate` nodes: the delegated session. */
  childSessionId?: string;
  /** `subagent` nodes: latest info from the native subagent part. */
  subagent?: SubagentInfo;
  /** `files` nodes with checkpoints: the turn's review range. */
  review?: { from: string; to: string; fileCount: number };
  /** `edit` groups: edited paths; `files` nodes without checkpoints: changed paths. */
  files?: string[];
  /** `document` nodes: path relative to the session root, `/` separators. */
  path?: string;
}

export type TaskMapEdgeKind = 'flow' | 'delegate' | 'return' | 'produce';
export interface TaskMapEdge { id: string; from: string; to: string; kind: TaskMapEdgeKind }

export interface TaskMapPhase {
  id: string;
  index: number;
  turnId?: string;
  /** "Turn 3" / "第 3 轮". */
  label: string;
  /** First line of the turn's prompt, ≤ 80 chars. */
  prompt?: string;
  /** The root user item that opened the turn ("Show in Chat"). */
  promptItemId?: string;
  status: TaskMapStatus;
  elapsedMs?: number;
  startedAt?: number;
}

export interface TaskMapGraph {
  rootSessionId: string;
  lanes: TaskMapLane[];
  nodes: TaskMapNode[];
  edges: TaskMapEdge[];
  phases: TaskMapPhase[];
  /** Older root turns left out by `maxPhases`. */
  hiddenPhases: number;
}

export type TaskMapCopy = (en: string, zh: string) => string;

export interface TaskMapInput {
  rootSessionId: string;
  sessions: readonly Session[];
  /** Loaded chat items per session id (root and delegates). A missing entry means not loaded (yet). */
  items: ReadonlyMap<string, readonly ChatItem[]>;
  /** Pinned documents of the root session. */
  documents?: readonly SessionDocument[];
  /** Build only the last N root turns (default 40). */
  maxPhases?: number;
  copy: TaskMapCopy;
  /** Turn label language for "Turn N". */
  zh: boolean;
}

export interface TaskMapSessions {
  /** Root first, then delegates breadth-first (depth ≤ 4). */
  sessions: Session[];
  /** Delegates left out by the 24-delegate cap. */
  hiddenDelegates: number;
}

// Vertical flow (taskFlow.ts) — design §11. The graph above is flattened into rows: turns, then each agent's steps
// with delegate/subagent work nested under the step that started it.

export type TaskFlowRowKind = 'earlier' | 'turn' | 'step' | 'details';

export interface TaskFlowRow {
  /** Stable across rebuilds: `earlier`, `turn:<phase id>`, the node id (step rows), `details:<node id>`. */
  key: string;
  kind: TaskFlowRowKind;
  /** Index into `TaskMapGraph.phases` (`earlier`: -1). */
  phase: number;
  /** 0 for turn rows and the root agent's steps; +1 per delegate/subagent nesting level. Details rows: their step's depth. */
  depth: number;
  /** `step` and `details` rows. */
  nodeId?: string;
  /** `turn` rows. */
  phaseId?: string;
  /** Turn rows, and delegate step rows whose delegate has steps of its own. */
  expandable?: boolean;
  expanded?: boolean;
  /** Collapsed turn/delegate rows: what is folded inside (all depths). */
  hidden?: { steps: number; delegates: number };
  /** Delegate and subagent rows: when the branch ran, as fractions of its turn's time span (0 ≤ start ≤ end ≤ 1). */
  bar?: { start: number; end: number };
  /** Turn rows: the turn's duration. Delegate/subagent rows: the branch's duration. When known. */
  durationMs?: number;
}

export interface TaskFlowExpansion {
  /** `default`: the last turn, turns that run or wait, and delegates that run, wait or failed are open. */
  mode: 'default' | 'all' | 'none';
  /** Row keys (turn and delegate rows) the user opened or closed explicitly; they override the mode. */
  open: ReadonlySet<string>;
  closed: ReadonlySet<string>;
  /** Row keys opened because a synced Chat shows them; `closed` wins over these. */
  auto?: ReadonlySet<string>;
  /** Step row whose inline details are open (at most one). */
  details?: string;
}

export interface TaskFlow {
  rows: TaskFlowRow[];
  /** Every node id (also nodes folded away) → keys of its enclosing rows, outermost first (turn, then delegate rows). */
  ancestors: Map<string, string[]>;
}

/** Where a node's content lives in a Chat. */
export interface TaskFlowChatTarget {
  sessionId: string;
  itemId?: string;
  /** `data-tool-id` of the tool card (`part.toolId`, else `<itemId>:part:<partIndex>`). */
  toolId?: string;
  /** The turn's first item id (`data-chat-turn`), the fallback when the item is not rendered on its own. */
  turnItemId?: string;
}

/** What a Chat reports as on screen (chatFlowSync.ts). */
export interface ChatViewState {
  sessionId: string;
  /** `data-chat-item` ids of on-screen messages, top to bottom. */
  items: string[];
  /** `data-tool-id`s of on-screen tool cards, plus every tool card inside an on-screen collapsed tools drawer. */
  tools: string[];
  /** `data-chat-turn` ids (first item id of a turn group) of on-screen turn sections, top to bottom. */
  turns: string[];
  /** The Chat follows live output (scrolled to the bottom). */
  following: boolean;
}

export interface TaskFlowIndex {
  /** `<sessionId>\n<itemId>` → ids of the nodes whose parts are in that item. */
  items: Map<string, string[]>;
  /** `<sessionId>\n<toolId>` → node ids. */
  tools: Map<string, string[]>;
  /** Root Chat item id → phase index (every root item of a shown turn, also items that are not nodes). */
  phases: Map<string, number>;
  /** Node id → where it lives in a Chat (nodes from Chat parts only; outputs have none). */
  targets: Map<string, TaskFlowChatTarget>;
}

export interface TaskFlowInView { nodes: Set<string>; phases: Set<number> }

export interface TaskFlowSummary {
  /** Root provider first, then delegate and subagent providers in order of first appearance. */
  agents: { provider: string; count: number }[];
  turns: number;
  /** Nodes except outputs and prompts. */
  steps: number;
  /** Sum of `files` node counts. */
  fileChanges: number;
  /** Sum of the shown turns' `elapsedMs`, when any is known. */
  durationMs?: number;
}

export interface TaskFlowMetrics {
  turnHeight: number;
  stepHeight: number;
  earlierHeight: number;
  /** Height used for a details row until it is measured. */
  detailsEstimate: number;
  indent: number;
}
