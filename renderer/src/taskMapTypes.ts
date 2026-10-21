import type { ChatItem, Session, SessionDocument, SubagentInfo } from '@threadterm/protocol';

/** Task map (task 10-21-task-map): a Chat task's lifecycle as lanes × turns, drawn as a vertical topology. Design: .trellis/tasks/10-21-task-map/design.md §12 */

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

// Vertical topology (taskGraph.ts) — design §12. Time runs down, agents are columns (reused once a lane ends), turns
// are horizontal bands. Folding a turn or a delegate lane draws one summary box per lane instead of its nodes, so every
// fork, return and output edge stays connected at any level of detail.

export interface TaskGraphExpansion {
  /** Turns. `default`: the last turn and turns that run or wait are open. `all`/`none`: every turn open/folded.
   *  Delegate lanes are open unless their key is in `closed`. */
  mode: 'default' | 'all' | 'none';
  /** `turn:<phase id>` and `lane:<lane id>` keys the user opened or closed explicitly; they override the mode. */
  open: ReadonlySet<string>;
  closed: ReadonlySet<string>;
  /** Keys opened because a synced Chat shows them; `closed` wins over these. */
  auto?: ReadonlySet<string>;
}

export interface TaskGraphMetrics {
  /** Box width bounds; the layout uses the widest width that fits every column in `width` (design §12.3). */
  minBoxWidth: number;
  maxBoxWidth: number;
  boxHeight: number;
  /** Horizontal space between columns; vertical edge segments run here. */
  columnGap: number;
  /** Vertical space above every row; horizontal edge segments run here. */
  rowGap: number;
  /** Turn header at the top of every band. */
  turnHeight: number;
  /** Space after a band. */
  bandGap: number;
  /** The "Show N earlier turns" band. */
  earlierHeight: number;
  /** World padding on every side. */
  padding: number;
}

export interface TaskGraphLayoutOptions {
  /** Width available to the world (the scroll container's client width). */
  width: number;
  metrics?: TaskGraphMetrics;
  /** `taskGraphAncestors(graph)` when the caller already has it (it does not depend on the expansion). */
  ancestors?: Map<string, string[]>;
}

export type TaskGraphBoxKind = 'node' | 'summary';

/** A drawn box: one graph node, or the nodes of one lane in one phase folded together. */
export interface TaskGraphBox {
  /** Node boxes: the node id. Summary boxes: `fold:<lane id>:<phase id>`. */
  id: string;
  kind: TaskGraphBoxKind;
  /** Node boxes only. */
  nodeId?: string;
  /** The nodes the box stands for, in graph order (node boxes: `[nodeId]`). A folded delegate lane's summary also
   *  holds its descendant lanes' nodes of that phase. */
  members: string[];
  laneId: string;
  /** Index into `TaskMapGraph.phases`. */
  phase: number;
  /** Grid position. Rows count from 0 at the top of the world (bands do not reset them); column 0 is the root lane. */
  row: number;
  column: number;
  /** World px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Node boxes: the node's status. Summary boxes: running > waiting > failed > cancelled > done over the members. */
  status: TaskMapStatus;
  /** The first box of a delegate or subagent lane in the layout (it names the lane's agent). */
  head?: boolean;
  /** Summary boxes: what is folded inside (members except prompts). */
  folded?: { steps: number; delegates: number };
  /** Delegate node boxes: the child lane's span. Subagent boxes: the subagent's elapsed time. Summary boxes: the
   *  members' span. Only when known and > 0. */
  durationMs?: number;
}

export interface TaskGraphEdge {
  /** `<kind>:<from box>→<to box>`. */
  id: string;
  /** Box ids. */
  from: string;
  to: string;
  kind: TaskMapEdgeKind;
  /** SVG path data in world px: an orthogonal polyline with rounded corners, from the source box border to the
   *  target box border (the view adds the arrowhead). */
  d: string;
  /** Vertical extent of the path, for windowing. */
  top: number;
  bottom: number;
}

export interface TaskGraphBand {
  /** `turn:<phase id>`. */
  key: string;
  phase: number;
  open: boolean;
  /** World y of the band's turn header, and of the band's end (before the band gap). */
  top: number;
  bottom: number;
  /** Folded bands: what is folded inside, all lanes (nodes except prompts and outputs). */
  folded?: { steps: number; delegates: number };
}

/** Which lane holds a column over a vertical range; a column is reused after its lane ends. */
export interface TaskGraphLaneSpan {
  laneId: string;
  column: number;
  /** Top of the lane's first box and bottom of its last box. */
  top: number;
  bottom: number;
}

export interface TaskGraphLayout {
  /** Sorted by `y`, then `x`. */
  boxes: TaskGraphBox[];
  edges: TaskGraphEdge[];
  /** In phase order. */
  bands: TaskGraphBand[];
  /** Sorted by `top`. */
  lanes: TaskGraphLaneSpan[];
  /** Present when `graph.hiddenPhases > 0`: the "Show N earlier turns" band at the top. */
  earlier?: { top: number; bottom: number };
  /** Every node id (also folded or skipped ones) → the id of the box that shows it. Root prompts that a turn header
   *  stands for map to that band's key. */
  boxOf: Map<string, string>;
  /** Same as `taskGraphAncestors(graph)`. */
  ancestors: Map<string, string[]>;
  /** Left x of each column. The outputs column, when any output exists, is the last one. */
  columnX: number[];
  outputsColumn?: number;
  boxWidth: number;
  /** World size in px (`width` ≥ the requested width). */
  width: number;
  height: number;
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

