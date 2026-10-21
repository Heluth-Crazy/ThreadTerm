import { elapsedMs } from './subagentActivity';
import type { TaskFlowInView, TaskGraphBand, TaskGraphBox, TaskGraphEdge, TaskGraphExpansion, TaskGraphLayout, TaskGraphLayoutOptions, TaskGraphMetrics, TaskMapEdgeKind, TaskMapGraph, TaskMapLane, TaskMapNode, TaskMapPhase, TaskMapStatus } from './taskMapTypes';

export const TASK_GRAPH_METRICS: TaskGraphMetrics = { minBoxWidth: 132, maxBoxWidth: 248, boxHeight: 46, columnGap: 32, rowGap: 18, turnHeight: 32, bandGap: 6, earlierHeight: 32, padding: 12 };

const turnKey = (id: string): string => `turn:${id}`;
const dated = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const append = <K, T>(map: Map<K, T[]>, key: K, value: T): void => {
  const values = map.get(key);
  if (values) values.push(value); else map.set(key, [value]);
};
const phasesOf = (graph: TaskMapGraph): TaskMapPhase[] => graph.phases.length || !graph.nodes.length ? graph.phases
  : [{ id: 'unphased', index: 0, label: '', status: 'done' }];
const phaseOf = (node: TaskMapNode, phases: readonly TaskMapPhase[]): number => Number.isInteger(node.phase) && node.phase >= 0 && node.phase < phases.length ? node.phase : 0;
const isOutput = (node: TaskMapNode, lanes: ReadonlyMap<string, TaskMapLane>): boolean => node.kind === 'files' || node.kind === 'document' || node.laneId === 'outputs' || lanes.get(node.laneId)?.kind === 'outputs';
const counts = (members: readonly TaskMapNode[]): { steps: number; delegates: number } => {
  let steps = 0, delegates = 0;
  for (const node of members) if (node.kind !== 'prompt' && node.kind !== 'files' && node.kind !== 'document') {
    steps++; if (node.kind === 'delegate' || node.kind === 'subagent') delegates++;
  }
  return { steps, delegates };
};

export function taskGraphAncestors(graph: TaskMapGraph): Map<string, string[]> {
  const lanes = new Map(graph.lanes.map(lane => [lane.id, lane])), phases = phasesOf(graph);
  const paths = new Map<string, string[]>(), result = new Map<string, string[]>();
  for (const node of graph.nodes) {
    let path = paths.get(node.laneId);
    if (!path) {
      path = [];
      const seen = new Set<string>();
      let lane = lanes.get(node.laneId);
      while (lane && !seen.has(lane.id)) {
        seen.add(lane.id);
        if (lane.kind === 'delegate') path.unshift(`lane:${lane.id}`);
        lane = lane.parentLaneId ? lanes.get(lane.parentLaneId) : undefined;
      }
      paths.set(node.laneId, path);
    }
    result.set(node.id, [turnKey(phases[phaseOf(node, phases)]?.id ?? 'unphased'), ...(isOutput(node, lanes) ? [] : path)]);
  }
  return result;
}

export function taskGraphOpen(key: string, graph: TaskMapGraph, expansion: TaskGraphExpansion): boolean {
  if (expansion.closed.has(key)) return false;
  if (key.startsWith('lane:')) return true;
  if (expansion.open.has(key) || expansion.auto?.has(key)) return true;
  if (expansion.mode !== 'default') return expansion.mode === 'all';
  const phases = phasesOf(graph), index = phases.findIndex(phase => turnKey(phase.id) === key), phase = phases[index];
  return !!phase && (index === phases.length - 1 || phase.status === 'running' || phase.status === 'waiting');
}

interface FoldEdge { id: string; from: string; to: string; kind: TaskMapEdgeKind }
interface Point { x: number; y: number }
interface Rail { gutter: number; from: number; to: number; x: number }
interface Route { edge: FoldEdge; points: Point[]; rails: Rail[] }
const layoutMetrics = new WeakMap<TaskGraphLayout, TaskGraphMetrics>();

/** A small heap keeps Kahn's ready queue deterministic without repeatedly sorting it. */
class Ready {
  private values: TaskGraphBox[] = [];
  constructor(private compare: (a: TaskGraphBox, b: TaskGraphBox) => number) {}
  push(value: TaskGraphBox): void {
    let index = this.values.length;
    this.values.push(value);
    while (index) {
      const parent = (index - 1) >>> 1;
      if (this.compare(this.values[parent]!, value) <= 0) break;
      this.values[index] = this.values[parent]!; index = parent;
    }
    this.values[index] = value;
  }
  pop(): TaskGraphBox | undefined {
    const first = this.values[0], last = this.values.pop();
    if (!this.values.length || !last) return first;
    let index = 0;
    while (index * 2 + 1 < this.values.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.values.length && this.compare(this.values[child + 1]!, this.values[child]!) < 0) child++;
      if (this.compare(last, this.values[child]!) <= 0) break;
      this.values[index] = this.values[child]!; index = child;
    }
    this.values[index] = last;
    return first;
  }
}

/** Fold first, schedule rows, reuse inactive columns, then route exclusively in free channels. */
export function layoutTaskGraph(graph: TaskMapGraph, expansion: TaskGraphExpansion, options: TaskGraphLayoutOptions): TaskGraphLayout {
  const metrics = options.metrics ?? TASK_GRAPH_METRICS, phases = phasesOf(graph);
  const ancestors = options.ancestors ?? taskGraphAncestors(graph), lanes = new Map(graph.lanes.map(lane => [lane.id, lane]));
  const laneOrder = new Map(graph.lanes.map((lane, index) => [lane.id, index]));
  const nodes = new Map(graph.nodes.map(node => [node.id, node])), nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const rootId = graph.lanes.find(lane => lane.kind === 'agent' && lane.sessionId === graph.rootSessionId)?.id ?? `agent:${graph.rootSessionId}`;
  for (const node of graph.nodes) if (!lanes.has(node.laneId)) {
    lanes.set(node.laneId, { id: node.laneId, kind: node.laneId === rootId ? 'agent' : node.laneId === 'outputs' || node.kind === 'files' || node.kind === 'document' ? 'outputs' : 'delegate', title: '', depth: 0 });
    laneOrder.set(node.laneId, laneOrder.size);
  }
  const open = phases.map(phase => taskGraphOpen(turnKey(phase.id), graph, expansion));
  const groups = new Map<string, { laneId: string; phase: number; members: TaskMapNode[]; output: boolean }>();
  const boxOf = new Map<string, string>(), skipped = new Set<string>();
  const phaseNodes: TaskMapNode[][] = phases.map(() => []);
  const childEnds = new Map<string, number>();
  for (const node of graph.nodes) {
    const phase = phaseOf(node, phases), output = isOutput(node, lanes);
    phaseNodes[phase]!.push(node);
    const sessionId = lanes.get(node.laneId)?.sessionId;
    if (sessionId && dated(node.at)) childEnds.set(sessionId, Math.max(childEnds.get(sessionId) ?? -Infinity, node.at));
    if (node.laneId === rootId && node.kind === 'prompt' && node.parts[0]?.itemId === phases[phase]?.promptItemId && phases[phase]?.promptItemId !== undefined) {
      boxOf.set(node.id, turnKey(phases[phase]!.id)); skipped.add(node.id); continue;
    }
    const foldedLane = output ? undefined : ancestors.get(node.id)?.slice(1).find(key => expansion.closed.has(key));
    const laneId = foldedLane?.slice(5) ?? node.laneId;
    const key = output || (!foldedLane && open[phase]) ? node.id : `fold:${laneId}:${phases[phase]!.id}`;
    const group = groups.get(key);
    if (group) group.members.push(node); else groups.set(key, { laneId, phase, members: [node], output });
  }
  const rank: Record<TaskMapStatus, number> = { done: 0, cancelled: 1, failed: 2, waiting: 3, running: 4 };
  const boxes: TaskGraphBox[] = [], outputs = new Set<string>(), phaseBoxes: TaskGraphBox[][] = phases.map(() => []);
  for (const [key, group] of groups) {
    const first = group.members[0]!, summary = group.members.length > 1, id = summary ? key : first.id;
    let status = first.status, min = Infinity, max = -Infinity, durationMs: number | undefined;
    for (const node of group.members) {
      boxOf.set(node.id, id);
      if (rank[node.status] > rank[status]) status = node.status;
      if (dated(node.at)) { min = Math.min(min, node.at); max = Math.max(max, node.at); }
    }
    if (summary && max > min) durationMs = max - min;
    else if (!summary && first.kind === 'delegate' && dated(first.at)) {
      const last = childEnds.get(first.childSessionId ?? '');
      if (dated(last) && last > first.at) durationMs = last - first.at;
    } else if (!summary && first.kind === 'subagent' && first.subagent) {
      // A running agent's wall clock would make identical graph inputs yield different layouts.
      const duration = elapsedMs(first.subagent, Number.NaN);
      if (dated(duration) && duration > 0) durationMs = duration;
    }
    const box: TaskGraphBox = { id, kind: summary ? 'summary' : 'node', ...(summary ? { folded: counts(group.members) } : { nodeId: first.id }),
      members: group.members.map(node => node.id), laneId: group.laneId, phase: group.phase, status, row: 0, column: 0, x: 0, y: 0, width: 0, height: metrics.boxHeight,
      ...(durationMs === undefined ? {} : { durationMs }) };
    boxes.push(box); phaseBoxes[box.phase]!.push(box);
    if (group.output) outputs.add(id);
  }
  const byId = new Map(boxes.map(box => [box.id, box]));
  const compare = (a: TaskGraphBox, b: TaskGraphBox): number => {
    const an = nodes.get(a.members[0]!)!, bn = nodes.get(b.members[0]!)!;
    const at = dated(an.at) ? an.at : Infinity, bt = dated(bn.at) ? bn.at : Infinity;
    return (at === bt ? 0 : at < bt ? -1 : 1) || (laneOrder.get(a.laneId) ?? 0) - (laneOrder.get(b.laneId) ?? 0) || an.sequence - bn.sequence || lexical(a.id, b.id);
  };
  const laneBoxes = new Map<string, TaskGraphBox[]>();
  for (const box of boxes) if (!outputs.has(box.id)) append(laneBoxes, box.laneId, box);
  for (const list of laneBoxes.values()) {
    list.sort((a, b) => a.phase - b.phase || nodes.get(a.members[0]!)!.sequence - nodes.get(b.members[0]!)!.sequence || (nodeOrder.get(a.members[0]!) ?? 0) - (nodeOrder.get(b.members[0]!) ?? 0) || lexical(a.id, b.id));
    const first = list[0]!;
    if (lanes.get(first.laneId)?.kind === 'delegate' || lanes.get(first.laneId)?.kind === 'subagent') first.head = true;
  }

  const incomingFlow = new Map<string, string[]>(), outgoingFlow = new Map<string, string[]>();
  for (const edge of graph.edges) if (edge.kind === 'flow' && nodes.has(edge.from) && nodes.has(edge.to)) {
    append(incomingFlow, edge.to, edge.from); append(outgoingFlow, edge.from, edge.to);
  }
  const bridge = (id: string, direction: Map<string, string[]>): string[] => {
    const result = new Set<string>(), seen = new Set<string>(), todo = [id];
    while (todo.length) {
      const current = todo.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (skipped.has(current)) { for (const next of direction.get(current) ?? []) todo.push(next); }
      else { const box = boxOf.get(current); if (box && byId.has(box)) result.add(box); }
    }
    return [...result].sort(lexical);
  };
  const foldedEdges: FoldEdge[] = [], edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    let from = bridge(edge.from, incomingFlow), to = bridge(edge.to, outgoingFlow);
    if (edge.kind !== 'flow') {
      if (!from.length) from = bridge(edge.from, outgoingFlow);
      if (!to.length) to = bridge(edge.to, incomingFlow);
    }
    for (let source of from) for (const target of to) if (source !== target) {
      // A delegate can keep working after the parent took its result (a follow-up in a later turn): the return then
      // leaves from the lane's last box at or before the parent's turn, so it never points back up the map.
      if (edge.kind === 'return' && byId.get(source)!.phase > byId.get(target)!.phase) {
        const phase = byId.get(target)!.phase, earlier = (laneBoxes.get(byId.get(source)!.laneId) ?? []).filter(box => box.phase <= phase).at(-1);
        if (!earlier || earlier.id === target) continue;
        source = earlier.id;
      }
      const id = `${edge.kind}:${source}→${target}`;
      if (!edgeIds.has(id)) { edgeIds.add(id); foldedEdges.push({ id, from: source, to: target, kind: edge.kind }); }
    }
  }

  const constraints = new Map<string, { to: string; gap: number }[]>(), indegree = new Map(boxes.map(box => [box.id, 0]));
  const external = new Map<string, { from: string; gap: number }[]>();
  const constrain = (source: TaskGraphBox, target: TaskGraphBox, gap: number, checkCycle: boolean) => {
    if (source.id === target.id || source.phase > target.phase || outputs.has(source.id) || outputs.has(target.id)) return;
    if (source.phase < target.phase) { append(external, target.id, { from: source.id, gap }); return; }
    if (checkCycle) {
      const seen = new Set<string>(), todo = [target.id];
      while (todo.length) {
        const id = todo.pop()!;
        if (id === source.id) return;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const next of constraints.get(id) ?? []) todo.push(next.to);
      }
    }
    append(constraints, source.id, { to: target.id, gap }); indegree.set(target.id, indegree.get(target.id)! + 1);
  };
  for (const list of laneBoxes.values()) for (let index = 1; index < list.length; index++) constrain(list[index - 1]!, list[index]!, 1, false);
  const producers = new Map<string, string>();
  for (const edge of foldedEdges) {
    if (edge.kind === 'delegate' || edge.kind === 'return') constrain(byId.get(edge.from)!, byId.get(edge.to)!, open[byId.get(edge.to)!.phase] ? 1 : 0, true);
    if (edge.kind === 'produce' && !producers.has(edge.to)) producers.set(edge.to, edge.from);
  }
  let base = 0;
  const rowRanges: { base: number; rows: number }[] = [];
  for (let phase = 0; phase < phases.length; phase++) {
    const block = phaseBoxes[phase]!, ready = new Ready(compare);
    for (const box of block) if (!outputs.has(box.id)) {
      box.row = base;
      for (const edge of external.get(box.id) ?? []) box.row = Math.max(box.row, byId.get(edge.from)!.row + edge.gap);
      if (indegree.get(box.id) === 0) ready.push(box);
    }
    let next: TaskGraphBox | undefined, maxRow = base - 1;
    while ((next = ready.pop())) {
      maxRow = Math.max(maxRow, next.row);
      for (const edge of constraints.get(next.id) ?? []) {
        const target = byId.get(edge.to)!;
        target.row = Math.max(target.row, next.row + edge.gap);
        const remaining = indegree.get(target.id)! - 1; indegree.set(target.id, remaining);
        if (!remaining) ready.push(target);
      }
    }
    const occupied = new Set<number>();
    for (const box of block) if (outputs.has(box.id)) {
      const producer = byId.get(producers.get(box.id) ?? '');
      let row = Math.max(base, producer && producer.phase <= phase ? producer.row : base);
      while (occupied.has(row)) row++;
      occupied.add(row); box.row = row; maxRow = Math.max(maxRow, row);
    }
    rowRanges.push({ base, rows: maxRow - base + 1 }); base = maxRow + 1;
  }

  const intervals = [...laneBoxes].map(([laneId, list]) => ({ laneId, first: Math.min(...list.map(box => box.row)), last: Math.max(...list.map(box => box.row)), column: 0 }));
  intervals.sort((a, b) => a.first - b.first || (laneOrder.get(a.laneId) ?? 0) - (laneOrder.get(b.laneId) ?? 0) || lexical(a.laneId, b.laneId));
  const columns = new Map<string, number>([[rootId, 0]]), occupants = new Map<number, typeof intervals>();
  let highest = 0;
  for (const interval of intervals) {
    if (interval.laneId !== rootId) {
      let column = (columns.get(lanes.get(interval.laneId)?.parentLaneId ?? '') ?? 0) + 1;
      while ((occupants.get(column) ?? []).some(other => other.last >= interval.first - 1 && other.first <= interval.last + 1)) column++;
      interval.column = column; columns.set(interval.laneId, column); highest = Math.max(highest, column);
    }
    append(occupants, interval.column, interval);
  }
  const outputsColumn = outputs.size ? highest + 1 : undefined, columnCount = (outputsColumn ?? highest) + 1;
  const available = Number.isFinite(options.width) ? Math.max(0, options.width) : 0;
  const boxWidth = Math.max(metrics.minBoxWidth, Math.min(metrics.maxBoxWidth, Math.floor((available - 2 * metrics.padding - (columnCount - 1) * metrics.columnGap) / columnCount)));
  const columnX = Array.from({ length: columnCount }, (_, column) => metrics.padding + column * (boxWidth + metrics.columnGap));
  const width = Math.max(available, 2 * metrics.padding + columnCount * boxWidth + (columnCount - 1) * metrics.columnGap);
  let y = metrics.padding;
  const earlier = graph.hiddenPhases > 0 ? { top: y, bottom: y + metrics.earlierHeight } : undefined;
  if (earlier) y = earlier.bottom + metrics.bandGap;
  const bands: TaskGraphBand[] = [];
  for (let phase = 0; phase < phases.length; phase++) {
    const range = rowRanges[phase]!, top = y;
    const bottom = top + metrics.turnHeight + range.rows * (metrics.boxHeight + metrics.rowGap) + (range.rows ? metrics.rowGap : 0);
    bands.push({ key: turnKey(phases[phase]!.id), phase, open: open[phase]!, top, bottom,
      ...(open[phase] ? {} : { folded: counts(phaseNodes[phase]!) }) });
    for (const box of phaseBoxes[phase]!) {
      box.column = outputs.has(box.id) ? outputsColumn! : columns.get(box.laneId) ?? 0;
      box.width = boxWidth; box.x = columnX[box.column]!;
      box.y = top + metrics.turnHeight + metrics.rowGap + (box.row - range.base) * (metrics.boxHeight + metrics.rowGap);
    }
    y = bottom + metrics.bandGap;
  }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x || lexical(a.id, b.id));
  const spans = new Map<string, { laneId: string; column: number; top: number; bottom: number }>();
  for (const box of boxes) {
    const span = spans.get(box.laneId);
    if (span) span.bottom = Math.max(span.bottom, box.y + box.height);
    else spans.set(box.laneId, { laneId: box.laneId, column: box.column, top: box.y, bottom: box.y + box.height });
  }
  const layout: TaskGraphLayout = { boxes, bands, edges: routeEdges(foldedEdges, byId, boxes, columnX, metrics), lanes: [...spans.values()].sort((a, b) => a.top - b.top || a.column - b.column || lexical(a.laneId, b.laneId)),
    ...(earlier ? { earlier } : {}), boxOf, ancestors, columnX, ...(outputsColumn === undefined ? {} : { outputsColumn }), boxWidth, width,
    height: (bands.length || earlier ? y - metrics.bandGap : metrics.padding) + metrics.padding };
  layoutMetrics.set(layout, metrics);
  return layout;
}

function routeEdges(edges: FoldEdge[], byId: ReadonlyMap<string, TaskGraphBox>, boxes: readonly TaskGraphBox[], columnX: readonly number[], metrics: TaskGraphMetrics): TaskGraphEdge[] {
  const routes: Route[] = [], rails = new Map<number, { rail: Rail; route: number; order: number }[]>();
  const byColumn = new Map<number, TaskGraphBox[]>();
  for (const box of boxes) append(byColumn, box.column, box);
  const half = (n: number): number => Math.round(n * 2) / 2;
  for (const edge of edges) {
    const source = byId.get(edge.from)!, target = byId.get(edge.to)!;
    const sx = source.x + source.width / 2, sy = source.y + source.height / 2, tx = target.x + target.width / 2, ty = target.y + target.height / 2;
    const dy = edge.kind === 'delegate' ? -5 : edge.kind === 'return' ? 5 : 0;
    const right = target.column >= source.column, side = right ? source.x + source.width : source.x;
    const gutter = right ? source.column + 1 : source.column;
    const gutterX = (index: number): number => index === 0 ? metrics.padding / 2 : index === columnX.length
      ? source.width + columnX[index - 1]! + metrics.padding / 2 : columnX[index]! - metrics.columnGap / 2;
    const route: Route = { edge, points: [], rails: [] };
    const point = (x: number, y: number): void => { route.points.push({ x: half(x), y: half(y) }); };
    const rail = (index: number, from: number, to: number): void => {
      const item: Rail = { gutter: index, from, to, x: half(gutterX(index)) };
      route.rails.push(item); append(rails, index, { rail: item, route: routes.length, order: route.rails.length - 1 });
    };
    const column = byColumn.get(source.column) ?? [];
    const start = lowerBound(column, source.y + source.height, box => box.y);
    const blocked = source.column === target.column && target.y > source.y && column[start] !== target;
    if (source.column === target.column && target.y > source.y && !blocked) {
      point(sx, source.y + source.height); point(tx, target.y);
    } else if (source.row === target.row && Math.abs(source.column - target.column) === 1) {
      point(side, sy + dy); point(right ? target.x : target.x + target.width, ty + dy);
    } else if (target.y > source.y && source.column !== target.column) {
      const gap = target.y - metrics.rowGap / 2, gx = gutterX(gutter);
      point(side, sy + dy); point(gx, sy + dy); point(gx, gap); point(tx, gap); point(tx, target.y);
      rail(gutter, 1, 2);
    } else if (source.row === target.row && source.column !== target.column) {
      const gap = source.y - metrics.rowGap / 2, targetGutter = right ? target.column : target.column + 1;
      const gx = gutterX(gutter), targetX = gutterX(targetGutter);
      point(side, sy + dy); point(gx, sy + dy); point(gx, gap); point(targetX, gap); point(targetX, ty + dy); point(right ? target.x : target.x + target.width, ty + dy);
      rail(gutter, 1, 2); rail(targetGutter, 3, 4);
    } else {
      const gap = target.y > source.y ? target.y - metrics.rowGap / 2 : target.y + target.height + metrics.rowGap / 2;
      const gx = gutterX(gutter);
      point(side, sy + dy); point(gx, sy + dy); point(gx, gap); point(tx, gap); point(tx, target.y > source.y ? target.y : target.y + target.height);
      rail(gutter, 1, 2);
    }
    routes.push(route);
  }
  for (const list of rails.values()) {
    list.sort((a, b) => Math.min(routes[a.route]!.points[a.rail.from]!.y, routes[a.route]!.points[a.rail.to]!.y) - Math.min(routes[b.route]!.points[b.rail.from]!.y, routes[b.route]!.points[b.rail.to]!.y) || a.route - b.route || a.order - b.order);
    const ends = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < list.length; index++) {
      const entry = list[index]!, route = routes[entry.route]!, a = route.points[entry.rail.from]!, b = route.points[entry.rail.to]!;
      const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
      let track = ends.findIndex(end => end <= top);
      if (track < 0) track = index % 3;
      ends[track] = Math.max(ends[track]!, bottom);
      // Exterior padding is narrower than an interior gutter; clamp tracks to the available channel.
      const gutter = entry.rail.gutter, spread = gutter === 0 || gutter === columnX.length ? Math.min(6, metrics.padding / 2) : Math.min(6, metrics.columnGap / 2);
      a.x = b.x = entry.rail.x + (track - 1) * spread;
    }
  }
  return routes.map(route => {
    const points = route.points.filter((point, index, list) => !index || point.x !== list[index - 1]!.x || point.y !== list[index - 1]!.y);
    return { ...route.edge, d: roundedPath(points), top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)) };
  });
}

function roundedPath(points: readonly Point[]): string {
  const number = (value: number): string => String(Math.round(value * 2) / 2);
  const xy = (point: Point): string => `${number(point.x)} ${number(point.y)}`;
  if (!points.length) return '';
  let d = `M ${xy(points[0]!)}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!, point = points[index]!, next = points[index + 1]!;
    const before = Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y), after = Math.abs(next.x - point.x) + Math.abs(next.y - point.y);
    const radius = Math.floor(Math.min(6, before / 2, after / 2) * 2) / 2;
    if (!radius || (previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y)) { d += ` L ${xy(point)}`; continue; }
    const a = { x: point.x + Math.sign(previous.x - point.x) * radius, y: point.y + Math.sign(previous.y - point.y) * radius };
    const b = { x: point.x + Math.sign(next.x - point.x) * radius, y: point.y + Math.sign(next.y - point.y) * radius };
    d += ` L ${xy(a)} Q ${xy(point)} ${xy(b)}`;
  }
  if (points.length > 1) d += ` L ${xy(points[points.length - 1]!)}`;
  return d;
}

function lowerBound<T>(values: readonly T[], value: number, get: (item: T) => number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (get(values[mid]!) < value) lo = mid + 1; else hi = mid; }
  return lo;
}

export function taskGraphWindow(layout: TaskGraphLayout, top: number, bottom: number): { boxes: TaskGraphBox[]; edges: TaskGraphEdge[]; bands: TaskGraphBand[] } {
  if (bottom <= top) return { boxes: [], edges: [], bands: [] };
  const start = lowerBound(layout.boxes, top, box => box.y + box.height), end = lowerBound(layout.boxes, bottom, box => box.y);
  const first = lowerBound(layout.bands, top, band => band.bottom), last = lowerBound(layout.bands, bottom, band => band.top);
  return { boxes: layout.boxes.slice(start, end).filter(box => box.y + box.height > top), edges: layout.edges.filter(edge => edge.bottom >= top && edge.top < bottom),
    bands: layout.bands.slice(first, last).filter(band => band.bottom > top) };
}

export function taskGraphStickyBand(layout: TaskGraphLayout, scrollTop: number): { band: TaskGraphBand; shift: number } | undefined {
  const index = lowerBound(layout.bands, scrollTop, band => band.top) - 1, band = layout.bands[index];
  const height = (layoutMetrics.get(layout) ?? TASK_GRAPH_METRICS).turnHeight;
  if (!band?.open || band.bottom <= scrollTop || band.bottom <= band.top + height) return undefined;
  return { band, shift: Math.min(0, (layout.bands[index + 1]?.top ?? Infinity) - scrollTop - height) };
}

export function taskGraphLaneLabels(layout: TaskGraphLayout, top: number, bottom: number): { column: number; laneId: string }[] {
  const result = new Map<number, string>();
  for (const span of layout.lanes) {
    if (span.top >= bottom) break;
    if (span.column !== layout.outputsColumn && span.bottom > top && !result.has(span.column)) result.set(span.column, span.laneId);
  }
  return [...result].sort(([a], [b]) => a - b).map(([column, laneId]) => ({ column, laneId }));
}

export function taskGraphNeighbor(layout: TaskGraphLayout, id: string, direction: 'up' | 'down' | 'left' | 'right'): string | undefined {
  const bandIndex = layout.bands.findIndex(band => band.key === id), header = layout.bands[bandIndex];
  if (header || id === 'earlier') {
    if (direction === 'left' || direction === 'right') return undefined;
    if (id === 'earlier') return direction === 'down' ? layout.bands[0]?.key : undefined;
    if (direction === 'down') return layout.boxes.filter(box => box.phase === header!.phase).sort((a, b) => a.column - b.column || a.y - b.y || lexical(a.id, b.id))[0]?.id ?? layout.bands[bandIndex + 1]?.key;
    const previous = layout.bands[bandIndex - 1];
    if (!previous) return layout.earlier ? 'earlier' : undefined;
    return [...layout.boxes].reverse().find(box => box.phase === previous.phase && box.column === 0)?.id ?? previous.key;
  }
  const box = layout.boxes.find(box => box.id === id);
  if (!box) return undefined;
  if (direction === 'left' || direction === 'right') {
    const candidates = layout.boxes.filter(other => direction === 'left' ? other.column < box.column : other.column > box.column);
    candidates.sort((a, b) => Number(b.phase === box.phase) - Number(a.phase === box.phase) || Math.abs(a.column - box.column) - Math.abs(b.column - box.column) || Math.abs(a.y - box.y) - Math.abs(b.y - box.y) || a.y - b.y || lexical(a.id, b.id));
    return candidates[0]?.id;
  }
  const down = direction === 'down';
  const candidates = layout.boxes.filter(other => other.column === box.column && (down ? other.y > box.y : other.y < box.y));
  candidates.sort((a, b) => (down ? a.y - b.y : b.y - a.y) || lexical(a.id, b.id));
  const next = candidates[0];
  const bands = layout.bands.filter(band => down ? band.top > box.y && (!next || band.top < next.y) : band.top < box.y && (!next || band.top > next.y));
  return (down ? bands[0] : bands[bands.length - 1])?.key ?? next?.id;
}

export function taskGraphMarked(layout: TaskGraphLayout, inView: TaskFlowInView): Set<string> {
  const marked = new Set<string>(), phases = new Set<number>();
  const boxPhases = new Map(layout.boxes.map(box => [box.id, box.phase])), bandPhases = new Map(layout.bands.map(band => [band.key, band.phase]));
  for (const id of inView.nodes) {
    const key = layout.boxOf.get(id);
    if (key === undefined) continue;
    const phase = boxPhases.get(key) ?? bandPhases.get(key);
    if (phase !== undefined) { marked.add(key); phases.add(phase); }
  }
  for (const band of layout.bands) if (inView.phases.has(band.phase) && !phases.has(band.phase)) marked.add(band.key);
  return marked;
}

export function taskGraphAutoOpen(ancestors: ReadonlyMap<string, readonly string[]>, graph: TaskMapGraph, inView: TaskFlowInView, limit = 3): Set<string> {
  const wanted = new Set<string>(), phases = phasesOf(graph);
  for (const id of inView.nodes) for (const key of ancestors.get(id) ?? []) wanted.add(key);
  for (let phase = 0; phase < phases.length; phase++) if (inView.phases.has(phase)) wanted.add(turnKey(phases[phase]!.id));
  const turns = new Set(phases.filter(phase => wanted.has(turnKey(phase.id))).slice(0, Math.max(0, limit)).map(phase => turnKey(phase.id))), result = new Set(turns);
  for (const id of inView.nodes) {
    const path = ancestors.get(id) ?? [];
    if (path[0] && turns.has(path[0])) for (const key of path) result.add(key);
  }
  return result;
}

export function taskGraphRelated(layout: TaskGraphLayout, boxId: string): { boxes: Set<string>; edges: Set<string> } {
  const boxes = new Set<string>(), edges = new Set<string>();
  if (!layout.boxes.some(box => box.id === boxId)) return { boxes, edges };
  boxes.add(boxId);
  for (const edge of layout.edges) if (edge.from === boxId || edge.to === boxId) {
    edges.add(edge.id); boxes.add(edge.from); boxes.add(edge.to);
  }
  return { boxes, edges };
}
