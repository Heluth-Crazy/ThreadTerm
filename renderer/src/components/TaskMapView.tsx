import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatItem, Session, SessionDocument } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { restoreChat, upsertChatItem } from '../chatState';
import { providerLabel } from '../chatConnection';
import { formatChatDuration } from '../chatPresentation';
import { buildTaskMap, taskMapSessions } from '../taskMap';
import { flattenTaskFlow, TASK_FLOW_METRICS, taskFlowOffsets, taskFlowWindow, taskFlowStickyTurn, taskFlowIndex, taskFlowInView, taskFlowMarkedRows, taskFlowAutoOpen, taskFlowSummary } from '../taskFlow';
import { chatShown, watchChatView, revealInChat, openAndRevealInChat } from '../chatFlowSync';
import type { ChatViewState, TaskFlowChatTarget, TaskFlowExpansion, TaskFlowRow, TaskMapNode, TaskMapStatus } from '../taskMapTypes';
import { createRebuildScheduler, taskMapStatusLabel } from '../taskMapView';
import { AgentIcon, Icon } from './PrototypeIcon';
import { Select } from './ui/Select';
import { createTaskMapInspectorCache, TaskMapDetails } from './TaskMapInspector';
import './task-map.css';

export interface TaskMapViewProps {
  sessionId: string;
  sessions: readonly Session[];
  visible: boolean;
  zh: boolean;
  focus?: { sessionId: string; itemId?: string; key: string };
  onOpenSession?: (sessionId: string) => void;
  onOpenReview?: (target: { sessionId: string; checkpointId: string; toCheckpointId?: string; path: string }) => void;
  onOpenFile?: (target: { sessionId: string; path: string }) => void;
  onClose?: () => void;
}

const initialExpansion = (): TaskFlowExpansion => ({ mode: 'default', open: new Set(), closed: new Set() });

export const TaskMapView = memo(function TaskMapView(props: TaskMapViewProps) {
  const { sessionId, sessions, visible, zh, focus } = props;
  const copy = (en: string, cn: string) => zh ? cn : en;
  const root = sessions.find(session => session.id === sessionId);
  const [maxPhases, setMaxPhases] = useState(200);
  const items = useRef(new Map<string, ChatItem[]>());
  const documents = useRef<SessionDocument[]>([]);
  const current = useRef({ sessionId, sessions, zh, maxPhases });
  current.current = { sessionId, sessions, zh, maxPhases };
  const [graph, setGraph] = useState(() => buildTaskMap({ rootSessionId: sessionId, sessions: [], items: new Map(), copy, zh }));
  const lanesById = useMemo(() => new Map(graph.lanes.map(lane => [lane.id, lane])), [graph.lanes]);
  const nodesById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
  const taskSessions = useMemo(() => taskMapSessions(sessionId, sessions), [sessionId, sessions]);
  const [loads, setLoads] = useState<Record<string, { state: 'loading' | 'ready' | 'error'; error?: string }>>({});
  const [documentError, setDocumentError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [tabRow, setTabRow] = useState<string>();
  const [turn, setTurn] = useState('');
  const [expansion, setExpansion] = useState(initialExpansion);
  const [sync, setSync] = useState(() => { try { return localStorage.getItem('threadterm.taskMap.sync') !== 'off'; } catch { return true; } });
  const [chatStates, setChatStates] = useState<ChatViewState[]>([]);
  const [measured, setMeasured] = useState(new Map<string, number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [ready, setReady] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const detailsElement = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<string, HTMLButtonElement>());
  const [pendingRow, setPendingRow] = useState<{ key: string; align: 'top' | 'third' | 'nearest'; keyboard?: boolean; flash?: string }>();
  const [highlight, setHighlight] = useState<{ key: string; token: string }>();
  const lastInteraction = useRef(-Infinity);
  const ownScroll = useRef<number | undefined>(undefined);
  const followBottom = useRef(true);
  const inspectorCache = useRef(createTaskMapInspectorCache());
  const appliedFocus = useRef<string | undefined>(undefined);
  const initialized = useRef(false);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const staleSessions = useRef(new Set<string>());
  const knownSessions = useRef(new Set<string>());
  const eventBuffers = useRef(new Map<string, { seq: number; item: ChatItem }[]>());
  const loadStates = useRef<typeof loads>({});
  const documentState = useRef({ ready: false, stale: false, error: undefined as string | undefined });
  const reconciled = useRef({ sessions, zh, maxPhases });
  const reconcile = useRef<(immediate?: boolean) => void>(() => {});
  const resync = useRef<() => void>(() => {});
  const enqueue = useRef<(ids: string[], refresh?: boolean) => void>(() => {});
  const reloadDocuments = useRef<() => void>(() => {});
  const scheduler = useRef<ReturnType<typeof createRebuildScheduler> | undefined>(undefined);
  const rebuildCount = useRef(0);
  const initializedSession = useRef(sessionId);

  const rebuild = () => {
    if (!visibleRef.current) return;
    const config = current.current;
    const graph = buildTaskMap({ rootSessionId: config.sessionId, sessions: config.sessions, items: items.current,
      documents: documents.current, maxPhases: config.maxPhases, zh: config.zh, copy: (en, cn) => config.zh ? cn : en });
    rebuildCount.current += 1;
    setGraph(graph);
  };
  const rebuildRef = useRef(rebuild); rebuildRef.current = rebuild;

  useEffect(() => {
    if (initializedSession.current === sessionId) return;
    initializedSession.current = sessionId;
    items.current = new Map(); documents.current = []; initialized.current = false; appliedFocus.current = undefined;
    staleSessions.current.clear(); knownSessions.current.clear(); loadStates.current = {};
    documentState.current = { ready: false, stale: false, error: undefined }; rebuildCount.current = 0;
    inspectorCache.current = createTaskMapInspectorCache(); setLoads({}); setDocumentError(undefined);
    setSelected(undefined); setTabRow(undefined); setTurn(''); setMaxPhases(200);
    setExpansion(initialExpansion()); setMeasured(new Map()); setReady(false); setHighlight(undefined); setPendingRow(undefined);
    followBottom.current = true;
  }, [sessionId]);

  useEffect(() => {
    let epoch: string | undefined;
    let disconnected = false;
    const invalidate = () => {
      for (const id of knownSessions.current) staleSessions.current.add(id);
      documentState.current.stale = true;
      if (visibleRef.current) resync.current();
    };
    return subscribeEvents(event => {
      const transport = event.event === 'runtime.transport' ? event.data as { state?: string; epoch?: string } : undefined;
      const nextEpoch = transport?.epoch ?? event.epoch;
      const epochChanged = Boolean(epoch && nextEpoch && epoch !== nextEpoch);
      if (transport?.state === 'disconnected' || transport?.state === 'incompatible') disconnected = true;
      if (transport?.state === 'reconnected' || epochChanged || (transport?.state === 'connected' && disconnected)) {
        invalidate(); disconnected = false;
      }
      if (nextEpoch) epoch = nextEpoch;
      if (event.event !== 'chat.item') return;
      const data = event.data as { sessionId?: string; item?: ChatItem };
      if (!data.sessionId || !data.item) return;
      eventBuffers.current.get(data.sessionId)?.push({ seq: event.seq, item: data.item });
      const existing = items.current.get(data.sessionId);
      if (!existing) return;
      items.current.set(data.sessionId, upsertChatItem(existing, data.item));
      if (visibleRef.current) scheduler.current?.schedule();
    });
  }, [sessionId]);

  useEffect(() => {
    if (!visible || !root) return;
    let active = true;
    const queue: string[] = [];
    const requests = new Map<string, object>();
    const buffers = new Map<string, { seq: number; item: ChatItem }[]>();
    eventBuffers.current = buffers;
    let documentRequest = 0, documentsPending = false;
    const fresh = () => active && visibleRef.current;
    const work = createRebuildScheduler(250, () => {
      if (!fresh()) return;
      setLoads({ ...loadStates.current }); setDocumentError(documentState.current.error);
      rebuildRef.current();
    });
    scheduler.current = work;
    const flushWhenIdle = () => { if (fresh() && !queue.length && !requests.size && !documentsPending) work.flush(); };
    const loadState = (id: string, state: 'loading' | 'ready' | 'error', error?: string) => {
      if (fresh()) loadStates.current[id] = { state, error };
    };
    const runQueue = () => {
      while (fresh() && requests.size < 4 && queue.length) {
        const id = queue.shift()!;
        const ticket = {};
        requests.set(id, ticket); buffers.set(id, []);
        void request('chat.snapshot', { sessionId: id }).then(snapshot => {
          if (!fresh() || requests.get(id) !== ticket) return;
          items.current.set(id, restoreChat(snapshot, buffers.get(id) ?? []));
          staleSessions.current.delete(id); loadState(id, 'ready'); work.schedule();
        }).catch(caught => {
          if (!fresh() || requests.get(id) !== ticket) return;
          staleSessions.current.add(id);
          loadState(id, 'error', caught instanceof Error ? caught.message : String(caught));
          work.schedule();
        }).finally(() => {
          if (!fresh() || requests.get(id) !== ticket) return;
          requests.delete(id); buffers.delete(id);
          runQueue(); flushWhenIdle();
        });
      }
    };
    const add = (ids: string[], force = false) => {
      for (const id of ids) if (!requests.has(id) && !queue.includes(id) && (force || staleSessions.current.has(id) || !items.current.has(id))) {
        queue.push(id); loadState(id, 'loading');
      }
    };
    const interrupt = () => {
      const interrupted = [...requests.keys(), ...queue];
      for (const id of interrupted) staleSessions.current.add(id);
      requests.clear(); buffers.clear(); queue.length = 0;
      return interrupted;
    };
    enqueue.current = (ids, retry = false) => {
      if (!fresh()) return;
      const interrupted = retry ? interrupt() : [];
      add(ids, retry); add(interrupted);
      setLoads({ ...loadStates.current }); work.schedule(); runQueue(); flushWhenIdle();
    };
    const loadDocuments = (retry = false) => {
      if (!fresh() || !current.current.sessions.find(session => session.id === sessionId)?.projectId || (!retry && (documentsPending || (documentState.current.ready && !documentState.current.stale)))) return;
      const requestId = ++documentRequest;
      documentsPending = true; documentState.current.error = undefined;
      void request('session.documents.list', { sessionId }).then(result => {
        if (!fresh() || documentRequest !== requestId) return;
        documents.current = result; documentState.current = { ready: true, stale: false, error: undefined }; work.schedule();
      }).catch(caught => {
        if (!fresh() || documentRequest !== requestId) return;
        documentState.current.error = caught instanceof Error ? caught.message : String(caught);
        documentState.current.stale = true; work.schedule();
      }).finally(() => {
        if (!fresh() || documentRequest !== requestId) return;
        documentsPending = false; flushWhenIdle();
      });
    };
    reloadDocuments.current = () => loadDocuments(true);
    const synchronize = (immediate = false) => {
      if (!fresh()) return;
      const ids = taskMapSessions(sessionId, current.current.sessions).sessions.map(session => session.id);
      knownSessions.current = new Set(ids);
      add(ids); loadDocuments(); work.schedule(); runQueue();
      if (immediate) flushWhenIdle();
    };
    reconcile.current = synchronize;
    resync.current = () => { interrupt(); loadDocuments(true); synchronize(true); };
    reconciled.current = { sessions: current.current.sessions, zh: current.current.zh, maxPhases: current.current.maxPhases };
    synchronize(true);
    return () => {
      active = false;
      for (const id of [...queue, ...requests.keys()]) staleSessions.current.add(id);
      if (documentsPending) documentState.current.stale = true;
      work.dispose(); scheduler.current = undefined;
      eventBuffers.current = new Map();
      enqueue.current = () => {}; reconcile.current = () => {}; resync.current = () => {}; reloadDocuments.current = () => {};
    };
  }, [visible, sessionId, Boolean(root)]);

  useEffect(() => {
    const previous = reconciled.current;
    if (!visible || (previous.sessions === sessions && previous.zh === zh && previous.maxPhases === maxPhases)) return;
    reconciled.current = { sessions, zh, maxPhases };
    reconcile.current(previous.zh !== zh || previous.maxPhases !== maxPhases);
  }, [sessions, zh, maxPhases, visible]);

  const index = useMemo(() => taskFlowIndex(graph, items.current), [graph]);
  const baseFlow = useMemo(() => flattenTaskFlow(graph, expansion), [graph, expansion]);
  const inView = useMemo(() => taskFlowInView(index, sync ? chatStates : []), [index, sync, chatStates]);
  // Keep the Set's identity while its keys are unchanged: most Chat scrolls change no auto-opened row, so no re-flatten.
  const autoRef = useRef<Set<string>>(new Set());
  const auto = useMemo(() => {
    const next = taskFlowAutoOpen(baseFlow, inView), previous = autoRef.current;
    if (next.size === previous.size && [...next].every(key => previous.has(key))) return previous;
    autoRef.current = next; return next;
  }, [baseFlow, inView]);
  const flow = useMemo(() => flattenTaskFlow(graph, { ...expansion, auto }), [graph, expansion, auto]);
  const marked = useMemo(() => taskFlowMarkedRows(flow, inView), [flow, inView]);
  const summary = useMemo(() => taskFlowSummary(graph), [graph]);
  const offsets = useMemo(() => taskFlowOffsets(flow.rows, measured), [flow, measured]);
  const windowRange = taskFlowWindow(offsets.tops, offsets.total, scrollTop, viewportHeight);
  // Only an open turn keeps a sticky header; the next turn row pushes it up instead of sliding under it.
  const stickyCandidate = taskFlowStickyTurn(flow.rows, offsets.tops, scrollTop);
  const stickyIndex = stickyCandidate !== undefined && flow.rows[stickyCandidate]!.expanded ? stickyCandidate : undefined;
  const nextTurn = stickyIndex === undefined ? -1 : flow.rows.findIndex((row, i) => i > stickyIndex && row.kind === 'turn');
  const stickyShift = nextTurn < 0 ? 0 : Math.min(0, offsets.tops[nextTurn]! - scrollTop - TASK_FLOW_METRICS.turnHeight);
  const sessionKeys = taskSessions.sessions.map(session => session.id).join('\n');

  useEffect(() => {
    if (!visible || !root) return;
    if (!sync) { setChatStates(previous => previous.length ? [] : previous); return; }
    const states = new Map<string, ChatViewState>();
    const unwatch = sessionKeys.split('\n').filter(Boolean).map(id => watchChatView(id, state => {
      if (state) states.set(id, state); else states.delete(id);
      setChatStates([...states.values()]);
    }));
    return () => unwatch.forEach(stop => stop());
  }, [visible, sync, sessionKeys, Boolean(root)]);

  useEffect(() => {
    if (!visible || !list.current) return;
    const element = list.current;
    const measure = () => { if (visibleRef.current) setViewportHeight(element.clientHeight); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [visible, Boolean(root)]);

  const renderedDetails = flow.rows.slice(windowRange.start, windowRange.end).find(row => row.kind === 'details')?.key;
  useEffect(() => {
    if (!visible || !renderedDetails || !detailsElement.current) return;
    const element = detailsElement.current;
    const measure = () => {
      if (!visibleRef.current) return;
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height > 0) setMeasured(previous => previous.get(renderedDetails) === height ? previous : new Map([[renderedDetails, height]]));
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [visible, renderedDetails]);

  const scrollTo = (top: number) => {
    const element = list.current; if (!element) return;
    const next = Math.max(0, Math.min(top, Math.max(0, offsets.total - element.clientHeight)));
    ownScroll.current = next; element.scrollTop = next; setScrollTop(next);
  };
  const interaction = () => { lastInteraction.current = performance.now(); };
  const rowBottom = (i: number) => offsets.tops[i + 1] ?? offsets.total;

  useLayoutEffect(() => {
    if (!visible || !viewportHeight || !flow.rows.length) return;
    if (pendingRow) {
      const i = flow.rows.findIndex(row => row.key === pendingRow.key);
      // A target that is not in the flow (folded away, hidden phase) is dropped instead of blocking later moves.
      if (i < 0) { setPendingRow(undefined); return; }
      const details = flow.rows[i]!.kind === 'details';
      // Scroll once the opened details have their measured height.
      if (details && renderedDetails === pendingRow.key && !measured.has(pendingRow.key)) return;
      const top = offsets.tops[i], bottom = rowBottom(i), anchorTop = details ? offsets.tops[i - 1] ?? top : top;
      let next = scrollTop;
      if (pendingRow.align === 'top') next = top;
      else if (pendingRow.align === 'third') next = top - viewportHeight / 3;
      else if (anchorTop < scrollTop + TASK_FLOW_METRICS.turnHeight) next = anchorTop - TASK_FLOW_METRICS.turnHeight;
      else if (bottom > scrollTop + viewportHeight) next = Math.min(bottom - viewportHeight, anchorTop - TASK_FLOW_METRICS.turnHeight);
      if (Math.abs(Math.max(0, Math.min(next, Math.max(0, offsets.total - viewportHeight))) - scrollTop) > 1) { scrollTo(next); return; }
      if (pendingRow.keyboard && !rowElements.current.has(pendingRow.key)) return;
      rowElements.current.get(pendingRow.key)?.focus({ preventScroll: true });
      if (pendingRow.flash) setHighlight({ key: pendingRow.key, token: pendingRow.flash });
      setPendingRow(undefined); initialized.current = true; setReady(true);
      return;
    }
    if (!initialized.current && loads[sessionId] && !Object.values(loads).some(load => load.state === 'loading')) {
      initialized.current = true; scrollTo(offsets.total); setReady(true);
    } else if ((!sync || !chatStates.length) && followBottom.current) scrollTo(offsets.total);
  }, [visible, viewportHeight, flow, offsets, pendingRow, scrollTop, loads, sessionId, sync, chatStates, measured, renderedDetails]);

  useEffect(() => {
    if (!visible || !sync || !marked.size || pendingRow || !viewportHeight) return;
    const first = flow.rows.findIndex(row => marked.has(row.key));
    if (first < 0 || flow.rows.some((row, i) => marked.has(row.key) && rowBottom(i) > scrollTop + TASK_FLOW_METRICS.turnHeight && offsets.tops[i] < scrollTop + viewportHeight)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      if (!visibleRef.current) return;
      const remaining = 1500 - (performance.now() - lastInteraction.current);
      if (remaining > 0) { timer = setTimeout(follow, remaining); return; }
      scrollTo(offsets.tops[first] - viewportHeight / 3);
    };
    follow();
    return () => clearTimeout(timer);
  }, [visible, sync, marked, flow, offsets, viewportHeight, scrollTop, pendingRow]);

  const openKeys = (keys: readonly string[]) => setExpansion(previous => {
    const open = new Set(previous.open), closed = new Set(previous.closed);
    for (const key of keys) { open.add(key); closed.delete(key); }
    return { ...previous, open, closed };
  });
  const toggleRow = (row: TaskFlowRow) => setExpansion(previous => {
    const open = new Set(previous.open), closed = new Set(previous.closed);
    if (row.expanded) { open.delete(row.key); closed.add(row.key); }
    else { closed.delete(row.key); open.add(row.key); }
    return { ...previous, open, closed };
  });
  const toggleDetails = (nodeId: string) => {
    setSelected(nodeId); setTabRow(nodeId);
    const opening = expansion.details !== nodeId;
    setExpansion(previous => ({ ...previous, details: previous.details === nodeId ? undefined : nodeId }));
    if (opening) { followBottom.current = false; setPendingRow({ key: `details:${nodeId}`, align: 'nearest' }); }
  };
  const turnTarget = (phase: number): TaskFlowChatTarget | undefined => {
    const p = graph.phases[phase];
    const firstItem = p && [...index.phases].find(([, value]) => value === phase)?.[0];
    return p && (p.promptItemId || firstItem) ? { sessionId, itemId: p.promptItemId, turnItemId: firstItem } : undefined;
  };
  /** False when the step cannot be shown in a Chat now (Sync off, no target, an on-screen Chat without it, another
   *  session's Chat off screen); `onFailed` covers the root Chat that is opened first and then has nothing to show. */
  const revealTarget = (target: TaskFlowChatTarget | undefined, onFailed?: () => void) => {
    if (!sync || !target) return false;
    if (revealInChat(target)) return true;
    if (chatShown(target.sessionId) || target.sessionId !== sessionId) return false;
    openAndRevealInChat(target, props.onOpenSession, onFailed); return true;
  };
  const activate = (row: TaskFlowRow) => {
    interaction(); setSelected(row.key); setTabRow(row.key);
    if (row.kind === 'earlier') { setMaxPhases(value => value + 200); return; }
    if (row.kind === 'turn') {
      if (sync) { if (!row.expanded) openKeys([row.key]); revealTarget(turnTarget(row.phase)); }
      else toggleRow(row);
    } else if (row.nodeId) {
      const nodeId = row.nodeId;
      if (!revealTarget(index.targets.get(nodeId), () => toggleDetails(nodeId))) toggleDetails(nodeId);
    }
  };

  useEffect(() => {
    if (!visible || !focus || appliedFocus.current === focus.key || !graph.nodes.length) return;
    let key: string | undefined, keys: string[] = [];
    // A delegate's Chat also sends its top item; the delegate row wins, and root items select their turn.
    const byItem = Boolean(focus.itemId && focus.sessionId === sessionId);
    if (byItem) {
      const phase = index.phases.get(focus.itemId!);
      if (phase === undefined) { if (!Object.values(loads).some(load => load.state === 'loading')) appliedFocus.current = focus.key; return; }
      key = `turn:${graph.phases[phase].id}`; keys = [key];
    } else {
      const node = graph.nodes.find(node => node.childSessionId === focus.sessionId)
        ?? graph.nodes.find(node => node.sessionId === focus.sessionId && node.kind !== 'prompt');
      if (!node) return;
      keys = [...(flow.ancestors.get(node.id) ?? []), node.id]; key = node.id;
    }
    appliedFocus.current = focus.key; openKeys(keys); setSelected(key); setTabRow(key);
    followBottom.current = false;
    setPendingRow({ key, align: byItem ? 'top' : 'third', flash: byItem ? undefined : focus.key });
  }, [focus, graph, index, visible, loads]);

  const navigate = (key: string) => {
    setTabRow(key); followBottom.current = false;
    setPendingRow({ key, align: 'nearest', keyboard: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.task-map-details')) return;
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-row-key]')?.dataset.rowKey ?? tabRow;
    const rows = flow.rows.filter(row => row.kind !== 'details');
    const i = rows.findIndex(row => row.key === key), row = rows[i];
    if (!row) return;
    if (event.key === ' ' && row.nodeId) { event.preventDefault(); toggleDetails(row.nodeId); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)));
      navigate(rows[next].key);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (row.expandable && !row.expanded) toggleRow(row);
      else if (row.expandable && rows[i + 1]) {
        const child = rows[i + 1];
        if (child.nodeId && flow.ancestors.get(child.nodeId)?.includes(row.key)) navigate(child.key);
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.expandable && row.expanded) toggleRow(row);
      else {
        const parent = row.nodeId ? flow.ancestors.get(row.nodeId)?.at(-1) : undefined;
        if (parent) navigate(parent);
      }
    }
  };
  const statusLabel = (status: TaskMapStatus) => taskMapStatusLabel(status, copy);
  const count = (value: number) => value.toLocaleString(zh ? 'zh-CN' : 'en-US');
  const kindLabel = (node: TaskMapNode) => ({ prompt: copy('Prompt', '提示'), plan: copy('Plan', '计划'), tools: copy('Tools', '工具'), delegate: copy('Delegate', '委派'), subagent: copy('Subagent', '子代理'), approval: copy('Approval', '审批'), question: copy('Question', '问题'), error: copy('Error', '错误'), reply: copy('Reply', '回复'), files: copy('Files changed', '文件更改'), document: copy('Document', '文档') })[node.kind];
  const tabbable = tabRow && flow.rows.slice(windowRange.start, windowRange.end).some(row => row.key === tabRow) ? tabRow : flow.rows.slice(windowRange.start, windowRange.end).find(row => row.kind !== 'details')?.key;
  const hiddenLabel = (row: TaskFlowRow) => row.hidden ? [copy(`${row.hidden.steps} steps`, `${row.hidden.steps} 步`), row.hidden.delegates ? copy(`${row.hidden.delegates} delegates`, `${row.hidden.delegates} 个委派`) : undefined].filter(Boolean).join(' · ') : undefined;

  const rowContent = (row: TaskFlowRow, sticky = false) => {
    const node = row.nodeId ? nodesById.get(row.nodeId) : undefined;
    const phase = graph.phases[row.phase], status = node?.status ?? phase?.status;
    const provider = node?.childSessionId ? sessions.find(session => session.id === node.childSessionId)?.provider : node?.subagent?.provider;
    const label = row.kind === 'earlier' ? copy(`Show ${graph.hiddenPhases} earlier turns`, `显示更早的 ${graph.hiddenPhases} 轮`) : row.kind === 'turn' ? phase?.label : node?.label;
    const detailsOpen = node?.id === expansion.details;
    return <>
      {Array.from({ length: row.depth }, (_, level) => <i key={level} className="task-map-guide" style={{ left: 12 + (level + .5) * TASK_FLOW_METRICS.indent }} aria-hidden="true" />)}
      {row.expandable && <button type="button" className="icon-btn icon-btn-sm task-map-row-toggle" tabIndex={-1} aria-label={row.expanded ? copy('Collapse', '收起') : copy('Expand', '展开')} aria-expanded={row.expanded} onClick={() => { interaction(); toggleRow(row); }}><Icon name={row.expanded ? 'chevD' : 'chevR'} /></button>}
      <button type="button" className="task-map-row-body" ref={sticky ? undefined : element => { if (element) rowElements.current.set(row.key, element); else rowElements.current.delete(row.key); }}
        tabIndex={sticky ? -1 : tabbable === row.key ? 0 : -1} aria-current={!sticky && selected === row.key ? 'true' : undefined} aria-expanded={row.expandable ? row.expanded : undefined}
        aria-label={[label, node ? kindLabel(node) : undefined, !row.expanded ? hiddenLabel(row) : undefined, row.durationMs !== undefined ? formatChatDuration(row.durationMs, false) : undefined, status ? statusLabel(status) : undefined].filter(Boolean).join(' · ')}
        title={[label, node?.detail ?? phase?.prompt].filter(Boolean).join('\n')} onFocus={sticky ? undefined : () => setTabRow(row.key)} onClick={() => activate(row)}>
        {node && <span className="task-map-row-icon">{provider ? <AgentIcon provider={provider} size={16} /> : <Icon name={nodeIcon(node)} />}</span>}
        <span className="task-map-row-label">{label}</span>
        <span className="task-map-row-detail">{row.kind === 'turn' ? phase?.prompt : node?.detail}</span>
        {!row.expanded && row.hidden && <small className="task-map-hidden-count">{hiddenLabel(row)}</small>}
        {row.bar && <span className="task-map-time-bar" aria-hidden="true"><i style={{ left: `${row.bar.start * 100}%`, width: `${(row.bar.end - row.bar.start) * 100}%` }} /></span>}
        {row.durationMs !== undefined && <small className="task-map-duration">{formatChatDuration(row.durationMs, false)}</small>}
        {node && (status === 'failed' || status === 'waiting') && <small className="task-map-status-text">{statusLabel(status)}</small>}
        {status && <i className={`task-map-dot is-${status}`} aria-hidden="true" />}
      </button>
      {node ? <button type="button" className="icon-btn icon-btn-sm task-map-row-details" tabIndex={-1} aria-label={detailsOpen ? copy('Close details', '关闭详情') : copy('Step details', '步骤详情')} aria-expanded={detailsOpen} onClick={() => { interaction(); toggleDetails(node.id); }}><Icon name="chevD" /></button>
        : <span className="task-map-row-details-space" aria-hidden="true" />}
    </>;
  };

  if (!root) return <section className="task-map" aria-label={copy('Task map', '任务图')} data-session-id={sessionId} data-visible={visible} data-node-count={0} data-row-count={0} data-rebuild-count={rebuildCount.current} data-view-ready={false} data-sync={sync ? 'on' : 'off'}><div className="task-map-empty"><p className="note">{copy('This chat no longer exists.', '这个对话已不存在。')}</p><button className="btn" onClick={props.onClose}>{copy('Close', '关闭')}</button></div></section>;
  return <section className="task-map" aria-label={copy('Task map', '任务图')} data-session-id={sessionId} data-visible={visible} data-node-count={graph.nodes.length} data-row-count={flow.rows.length} data-view-ready={ready} data-rebuild-count={rebuildCount.current} data-sync={sync ? 'on' : 'off'}
    onKeyDown={event => { if (event.key !== 'Escape' || !expansion.details) return; event.preventDefault(); event.stopPropagation(); const key = expansion.details; setExpansion(previous => ({ ...previous, details: undefined })); navigate(key); }}>
    <div className="task-map-toolbar">
      <div className="task-map-title"><Icon name="flow" /><strong>{copy('Task map', '任务图')}</strong><span title={root.title}>{root.title}</span></div>
      {graph.lanes.some(lane => lane.status === 'running') && <span className="chip st-running task-map-live">{copy('Live', '实时')}</span>}
      <button className="btn btn-sm task-map-sync" aria-label={copy('Sync with Chat', '与对话同步')} title={copy('Sync with Chat', '与对话同步')} aria-pressed={sync} onClick={() => setSync(value => { try { localStorage.setItem('threadterm.taskMap.sync', value ? 'off' : 'on'); } catch { /* Storage can be unavailable in a fixture. */ } return !value; })}><Icon name="split" />{copy('Sync', '同步')}</button>
      <button className="btn btn-sm task-map-expand" onClick={() => { interaction(); setExpansion(previous => ({ ...initialExpansion(), mode: previous.mode === 'all' ? 'none' : 'all', details: previous.details })); }}>{expansion.mode === 'all' ? copy('Collapse all', '全部收起') : copy('Expand all', '全部展开')}</button>
      <Select className="btn btn-sm task-map-turn" aria-label={copy('Jump to turn', '跳转轮次')} value={turn} onChange={event => { const phase = graph.phases.findIndex(phase => phase.id === event.target.value); if (phase < 0) return; interaction(); setTurn(event.target.value); const key = `turn:${event.target.value}`; openKeys([key]); followBottom.current = false; setPendingRow({ key, align: 'top' }); revealTarget(turnTarget(phase)); }}><option value="">{copy('Jump to turn…', '跳转轮次…')}</option>{graph.phases.map(phase => <option key={phase.id} value={phase.id}>{phase.label}{phase.prompt ? ` · ${phase.prompt}` : ''}</option>)}</Select>
    </div>
    <div className="task-map-summary">{summary.agents.map(agent => <span key={agent.provider}><AgentIcon provider={agent.provider} size={14} />{providerLabel(agent.provider)}{agent.count > 1 ? ` ×${agent.count}` : ''}</span>)}<span>{copy(`${count(summary.turns)} turns · ${count(summary.steps)} steps`, `${count(summary.turns)} 轮 · ${count(summary.steps)} 步`)}<span className="task-map-summary-secondary">{copy(` · ${count(summary.fileChanges)} file changes`, ` · ${count(summary.fileChanges)} 处文件更改`)}{summary.durationMs !== undefined && ` · ${formatChatDuration(summary.durationMs, false)}`}</span></span></div>
    <div className="task-map-list" ref={list} onKeyDownCapture={interaction} onKeyDown={onKeyDown} onWheelCapture={interaction} onPointerDownCapture={interaction}
      onScroll={event => { const element = event.currentTarget; if (ownScroll.current === undefined || Math.abs(element.scrollTop - ownScroll.current) > 1) interaction(); ownScroll.current = undefined; followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24; setScrollTop(element.scrollTop); }}>
      {!flow.rows.length && <div className="task-map-empty"><p className="note" role="status">{Object.values(loads).some(load => load.state === 'loading') || (!items.current.has(sessionId) && loadStates.current[sessionId]?.state !== 'error') ? copy('Loading task map…', '正在加载任务图…') : copy('No activity yet. Send a message in the chat to start the map.', '还没有活动。在对话中发送消息后，这里会显示任务图。')}</p></div>}
      {stickyIndex !== undefined && <div aria-hidden="true" className={`task-map-sticky-turn${marked.has(flow.rows[stickyIndex].key) ? ' is-in-view' : ''}`} style={{ paddingLeft: 12, transform: stickyShift ? `translateY(${stickyShift}px)` : undefined }}>{rowContent(flow.rows[stickyIndex], true)}</div>}
      <div className="task-map-spacer" role="list" aria-label={copy('Task steps', '任务步骤')} style={{ height: offsets.total }}>
        {flow.rows.slice(windowRange.start, windowRange.end).map((row, localIndex) => {
          const i = windowRange.start + localIndex, node = row.nodeId ? nodesById.get(row.nodeId) : undefined;
          const status = node?.status ?? graph.phases[row.phase]?.status;
          const rowClass = `task-map-row${selected === row.key ? ' is-selected' : ''}${marked.has(row.key) ? ' is-in-view' : ''}${row.expanded ? ' is-open' : ''}${status ? ` is-${status}` : ''}${row.nodeId && expansion.details === row.nodeId ? ' has-details' : ''}${highlight?.key === row.key ? ' chat-message-highlight' : ''}`;
          return <div key={`${row.key}:${highlight?.key === row.key ? highlight.token : ''}`} className={rowClass} role="listitem" data-row-key={row.key} data-row-kind={row.kind} data-node-id={row.nodeId} data-node-kind={node?.kind} data-phase={row.phase} data-depth={row.depth}
            onAnimationEnd={event => { if (event.animationName === 'chat-message-highlight' && highlight?.key === row.key) setHighlight(undefined); }}
            style={{ top: offsets.tops[i], height: row.kind === 'details' ? undefined : rowBottom(i) - offsets.tops[i], paddingLeft: 12 + row.depth * TASK_FLOW_METRICS.indent }}>
            {row.kind === 'details' && Array.from({ length: row.depth }, (_, level) => <i key={level} className="task-map-guide" style={{ left: 12 + (level + .5) * TASK_FLOW_METRICS.indent }} aria-hidden="true" />)}
            {row.kind === 'details' && node ? <div ref={detailsElement} className="task-map-details-measure"><TaskMapDetails key={node.id} node={node} lane={lanesById.get(node.laneId)} durationMs={flow.rows[i - 1]?.durationMs} target={index.targets.get(node.id)} sessions={sessions} items={items.current} zh={zh} visible={visible} cache={inspectorCache.current} onOpenSession={props.onOpenSession} onOpenReview={props.onOpenReview} onOpenFile={props.onOpenFile} /></div> : rowContent(row)}
          </div>;
        })}
      </div>
    </div>
    {Object.values(loads).some(load => load.state === 'error') && <div className="task-map-load-errors">{Object.entries(loads).filter(([, load]) => load.state === 'error').map(([id, load]) => <div key={id} className="surface-error" title={load.error}>{sessions.find(session => session.id === id)?.title}: {copy('Could not load', '加载失败')}<button className="btn btn-sm" onClick={() => enqueue.current([id], true)}>{copy('Retry', '重试')}</button></div>)}</div>}
    {documentError && <div className="task-map-document-error surface-error">{documentError}<button className="btn btn-sm" onClick={() => reloadDocuments.current()}>{copy('Retry', '重试')}</button></div>}
    {taskSessions.hiddenDelegates > 0 && <p className="note task-map-limit">{copy(`${taskSessions.hiddenDelegates} delegates are outside the map limit.`, `${taskSessions.hiddenDelegates} 个委派超出任务图限制。`)}</p>}
  </section>;
}, (previous, next) => !previous.visible && !next.visible);

function nodeIcon(node: TaskMapNode): string {
  if (node.kind === 'tools') return ({ explore: 'search', command: 'terminal', edit: 'file', browser: 'globe', mcp: 'plug', delegation: 'agents', tool: 'wrench' })[node.step ?? 'tool'];
  return ({ prompt: 'agents', plan: 'check', delegate: 'agents', subagent: 'spark', approval: 'shield', question: 'info', error: 'close', reply: 'check', files: 'file', document: 'file' })[node.kind];
}

export default TaskMapView;
