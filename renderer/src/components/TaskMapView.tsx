import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ChatItem, Session, SessionDocument } from '@threadterm/protocol';
import { request, subscribeEvents } from '../bridge';
import { restoreChat, upsertChatItem } from '../chatState';
import { agentName } from '../agents';
import { formatChatDuration } from '../chatPresentation';
import { buildTaskMap, taskMapSessions } from '../taskMap';
import { taskFlowIndex, taskFlowInView, taskFlowSummary } from '../taskFlow';
import { TASK_GRAPH_METRICS, taskGraphAncestors, layoutTaskGraph, taskGraphWindow, taskGraphStickyBand, taskGraphLaneLabels, taskGraphNeighbor, taskGraphMarked, taskGraphAutoOpen, taskGraphRelated, taskGraphOpen } from '../taskGraph';
import { watchChatView, revealInChat } from '../chatFlowSync';
import type { ChatViewState, TaskFlowChatTarget, TaskGraphExpansion, TaskGraphBox, TaskGraphBand, TaskGraphLayout, TaskMapNode, TaskMapStatus } from '../taskMapTypes';
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

const initialExpansion = (): TaskGraphExpansion => ({ mode: 'default', open: new Set(), closed: new Set() });

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
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [tabWidth, setTabWidth] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const rowElements = useRef(new Map<string, HTMLButtonElement>());
  const [pendingRow, setPendingRow] = useState<{ key: string; align: 'top' | 'third' | 'nearest'; keyboard?: boolean; flash?: string; reveal?: boolean }>();
  const [highlight, setHighlight] = useState<{ key: string; token: string }>();
  const lastInteraction = useRef(-Infinity);
  const ownScroll = useRef<{ top: number; left: number } | undefined>(undefined);
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
    setExpansion(initialExpansion()); setDetailsOpen(false); setReady(false); setHighlight(undefined); setPendingRow(undefined);
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
  const ancestors = useMemo(() => taskGraphAncestors(graph), [graph]);
  const inView = useMemo(() => taskFlowInView(index, sync ? chatStates : []), [index, sync, chatStates]);
  const autoRef = useRef<Set<string>>(new Set());
  const auto = useMemo(() => {
    const next = taskGraphAutoOpen(ancestors, graph, inView), previous = autoRef.current;
    if (next.size === previous.size && [...next].every(key => previous.has(key))) return previous;
    autoRef.current = next; return next;
  }, [ancestors, graph, inView]);
  const layout = useMemo(() => layoutTaskGraph(graph, { ...expansion, auto }, { width: Math.max(0, viewportWidth - 1), ancestors }), [graph, expansion, auto, viewportWidth, ancestors]);
  const boxesById = useMemo(() => new Map(layout.boxes.map(box => [box.id, box])), [layout]);
  const bandsByKey = useMemo(() => new Map(layout.bands.map(band => [band.key, band])), [layout]);
  const marked = useMemo(() => taskGraphMarked(layout, inView), [layout, inView]);
  const related = useMemo(() => taskGraphRelated(layout, selected ?? ''), [layout, selected]);
  const summary = useMemo(() => taskFlowSummary(graph), [graph]);
  const windowRange = useMemo(() => taskGraphWindow(layout, scrollTop - 400, scrollTop + viewportHeight + 400), [layout, scrollTop, viewportHeight]);
  const sticky = taskGraphStickyBand(layout, scrollTop);
  const laneLabels = taskGraphLaneLabels(layout, scrollTop, scrollTop + viewportHeight);
  const sessionKeys = taskSessions.sessions.map(session => session.id).join('\n');
  const markerId = useId().replace(/:/g, '');
  const docked = tabWidth >= 900 ? 'right' : 'bottom';
  const selectedBox = selected ? boxesById.get(selected) : undefined;
  const panelOpen = detailsOpen && Boolean(selectedBox);
  const bottomInset = panelOpen && docked === 'bottom' ? Math.min((viewportHeight + (layout.columnX.length >= 2 ? 24 : 0)) / 2, 420) : 0;
  const usableHeight = Math.max(1, viewportHeight - bottomInset);

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
    if (!visible || !root || !list.current) return;
    const element = list.current;
    const measure = () => {
      if (!visibleRef.current) return;
      setViewportHeight(element.clientHeight); setViewportWidth(element.clientWidth);
      setTabWidth(section.current?.clientWidth ?? element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    if (section.current) observer.observe(section.current);
    return () => observer.disconnect();
  }, [visible, Boolean(root)]);

  const scrollTo = (top: number, left = scrollLeft) => {
    const element = list.current; if (!element) return;
    const nextTop = Math.max(0, Math.min(top, Math.max(0, layout.height + bottomInset - element.clientHeight)));
    const nextLeft = Math.max(0, Math.min(left, Math.max(0, layout.width - element.clientWidth)));
    if (Math.abs(element.scrollTop - nextTop) > .5 || Math.abs(element.scrollLeft - nextLeft) > .5) {
      ownScroll.current = { top: nextTop, left: nextLeft }; element.scrollTop = nextTop; element.scrollLeft = nextLeft;
    }
    setScrollTop(nextTop); setScrollLeft(nextLeft);
  };
  const interaction = () => { lastInteraction.current = performance.now(); };
  const intoViewLeft = (box: TaskGraphBox | undefined) => !box ? scrollLeft : box.x < scrollLeft ? box.x - 12 : box.x + box.width > scrollLeft + viewportWidth ? box.x + box.width - viewportWidth + 12 : scrollLeft;
  const rectFor = (key: string) => {
    const box = boxesById.get(key), band = bandsByKey.get(key);
    if (box) return { top: box.y, bottom: box.y + box.height, box };
    if (band) return { top: band.top, bottom: band.top + TASK_GRAPH_METRICS.turnHeight, box: undefined };
    if (key === 'earlier' && layout.earlier) return { ...layout.earlier, box: undefined };
    return undefined;
  };

  useLayoutEffect(() => {
    if (!visible || !viewportHeight || !viewportWidth) return;
    if (pendingRow) {
      const key = boxesById.has(pendingRow.key) || bandsByKey.has(pendingRow.key) || pendingRow.key === 'earlier' ? pendingRow.key : layout.boxOf.get(pendingRow.key);
      const rect = key && rectFor(key);
      if (!rect || !key) { setPendingRow(undefined); return; }
      let next = scrollTop;
      if (pendingRow.align === 'top') next = rect.top;
      else if (pendingRow.align === 'third') next = rect.top - usableHeight / 3;
      else if (rect.top < scrollTop + TASK_GRAPH_METRICS.turnHeight) next = rect.top - TASK_GRAPH_METRICS.turnHeight;
      else if (rect.bottom > scrollTop + usableHeight) next = rect.bottom - usableHeight;
      const left = intoViewLeft(rect.box);
      const clamped = Math.max(0, Math.min(next, Math.max(0, layout.height + bottomInset - viewportHeight)));
      if (Math.abs(clamped - scrollTop) > 1 || Math.abs(Math.max(0, Math.min(left, layout.width - viewportWidth)) - scrollLeft) > 1) { scrollTo(next, left); return; }
      if (pendingRow.keyboard && !rowElements.current.has(key)) return;
      if (pendingRow.keyboard) rowElements.current.get(key)?.focus({ preventScroll: true });
      if (pendingRow.flash) setHighlight({ key, token: pendingRow.flash });
      if (pendingRow.reveal) revealTarget(index.targets.get(pendingRow.key));
      setSelected(previous => previous === pendingRow.key ? key : previous);
      setTabRow(key); setPendingRow(undefined); initialized.current = true; setReady(true);
      return;
    }
    if (!initialized.current && loads[sessionId] && !Object.values(loads).some(load => load.state === 'loading')) {
      initialized.current = true; scrollTo(layout.height); setReady(true);
    } else if ((!sync || !chatStates.length) && followBottom.current) scrollTo(layout.height);
  }, [visible, viewportHeight, viewportWidth, layout, pendingRow, scrollTop, scrollLeft, loads, sessionId, sync, chatStates, usableHeight]);

  useEffect(() => {
    if (!visible || !sync || !marked.size || pendingRow || !viewportHeight) return;
    const targets = [...marked].map(key => ({ key, rect: rectFor(key) })).filter(value => value.rect).sort((a, b) => a.rect!.top - b.rect!.top || (a.rect!.box?.x ?? 0) - (b.rect!.box?.x ?? 0));
    if (!targets.length || targets.some(({ rect }) => rect!.bottom > scrollTop + TASK_GRAPH_METRICS.turnHeight && rect!.top < scrollTop + usableHeight && (!rect!.box || (rect!.box.x + rect!.box.width > scrollLeft && rect!.box.x < scrollLeft + viewportWidth)))) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      if (!visibleRef.current) return;
      const remaining = 1500 - (performance.now() - lastInteraction.current);
      if (remaining > 0) { timer = setTimeout(follow, remaining); return; }
      const rect = targets[0].rect!;
      scrollTo(rect.top - usableHeight / 3, intoViewLeft(rect.box));
    };
    follow();
    return () => clearTimeout(timer);
  }, [visible, sync, marked, layout, viewportHeight, viewportWidth, scrollTop, scrollLeft, pendingRow, usableHeight]);

  const selectedMember = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible || !selected || boxesById.has(selected) || bandsByKey.has(selected)) return;
    const next = layout.boxOf.get(selectedMember.current ?? selected);
    setSelected(next); if (!next) setDetailsOpen(false);
  }, [visible, layout, selected]);

  const openKeys = (keys: readonly string[]) => setExpansion(previous => {
    const open = new Set(previous.open), closed = new Set(previous.closed);
    for (const key of keys) { open.add(key); closed.delete(key); }
    return { ...previous, open, closed };
  });
  const setKeyOpen = (key: string, isOpen: boolean) => setExpansion(previous => {
    if (taskGraphOpen(key, graph, { ...previous, auto }) === isOpen && (isOpen ? previous.open.has(key) : previous.closed.has(key))) return previous;
    const open = new Set(previous.open), closed = new Set(previous.closed);
    if (isOpen) { closed.delete(key); open.add(key); } else { open.delete(key); closed.add(key); }
    return { ...previous, open, closed };
  });
  const turnTarget = (phase: number): TaskFlowChatTarget | undefined => {
    const p = graph.phases[phase];
    const firstItem = p && [...index.phases].find(([, value]) => value === phase)?.[0];
    return p && (p.promptItemId || firstItem) ? { sessionId, itemId: p.promptItemId, turnItemId: firstItem } : undefined;
  };
  const revealTarget = (target: TaskFlowChatTarget | undefined) => Boolean(sync && target && revealInChat(target));
  const selectMember = (nodeId: string, reveal = false, keyboard = true) => {
    openKeys(ancestors.get(nodeId) ?? []); selectedMember.current = nodeId;
    setSelected(nodeId); setTabRow(nodeId); followBottom.current = false;
    setPendingRow({ key: nodeId, align: 'nearest', reveal, keyboard });
  };
  const activateBox = (id: string) => {
    const box = boxesById.get(id); if (!box) return;
    interaction(); setSelected(id); setTabRow(id); selectedMember.current = box.nodeId ?? box.members[0];
    if (box.kind === 'summary') {
      const first = box.members.find(id => nodesById.get(id)?.kind !== 'prompt') ?? box.members[0];
      if (first) selectMember(first, sync, true);
      return;
    }
    if (!revealTarget(box.nodeId ? index.targets.get(box.nodeId) : undefined)) { followBottom.current = false; setDetailsOpen(true); }
  };
  const toggleDetails = (id: string) => {
    setDetailsOpen(previous => selected === id ? !previous : true); setSelected(id); setTabRow(id);
    selectedMember.current = boxesById.get(id)?.members[0]; followBottom.current = false;
    setPendingRow({ key: id, align: 'nearest', keyboard: true });
  };
  const activateTurn = (band: TaskGraphBand) => {
    interaction(); setSelected(band.key); setTabRow(band.key);
    if (sync) { if (!band.open) openKeys([band.key]); revealTarget(turnTarget(band.phase)); }
    else setKeyOpen(band.key, !band.open);
  };

  useEffect(() => {
    if (!visible || !focus || appliedFocus.current === focus.key || !graph.nodes.length) return;
    let key: string | undefined, keys: string[] = [];
    const byItem = Boolean(focus.itemId && focus.sessionId === sessionId);
    if (byItem) {
      const phase = index.phases.get(focus.itemId!);
      if (phase === undefined) { if (!Object.values(loads).some(load => load.state === 'loading')) appliedFocus.current = focus.key; return; }
      key = `turn:${graph.phases[phase].id}`; keys = [key];
    } else {
      const node = graph.nodes.find(node => node.kind === 'delegate' && node.childSessionId === focus.sessionId)
        ?? graph.nodes.find(node => node.sessionId === focus.sessionId && node.kind !== 'prompt');
      if (!node) return;
      keys = [...(ancestors.get(node.id) ?? [])]; key = node.id; selectedMember.current = node.id;
    }
    appliedFocus.current = focus.key; openKeys(keys); setSelected(key); setTabRow(key);
    followBottom.current = false;
    setPendingRow({ key, align: byItem ? 'top' : 'third', keyboard: true, flash: byItem ? undefined : focus.key });
  }, [focus, graph, index, visible, loads]);

  const navigate = (key: string) => {
    setTabRow(key); followBottom.current = false;
    setPendingRow({ key, align: 'nearest', keyboard: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.task-graph-details, .task-graph-fold, .task-graph-turn-toggle')) return;
    const key = target.closest<HTMLElement>('[data-nav-key]')?.dataset.navKey ?? tabRow;
    if (!key) return;
    const box = boxesById.get(key), band = bandsByKey.get(key);
    if (event.key === ' ' && box) { event.preventDefault(); toggleDetails(key); return; }
    if (event.key === 'Enter' && box) { event.preventDefault(); activateBox(key); return; }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const next = event.key === 'Home' ? layout.boxes[0] : layout.boxes.at(-1); if (next) navigate(next.id); return;
    }
    if (box && ['-', '+', '='].includes(event.key)) {
      const lane = lanesById.get(box.laneId);
      const laneKey = lane?.kind === 'delegate' ? `lane:${lane.id}` : (ancestors.get(box.members[0]) ?? []).filter(key => key.startsWith('lane:')).at(-1);
      if (laneKey) { event.preventDefault(); setKeyOpen(laneKey, event.key !== '-'); setPendingRow({ key: box.members[0], align: 'nearest', keyboard: true }); }
      return;
    }
    const directions: Record<string, 'up' | 'down' | 'left' | 'right' | undefined> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    if (band && (direction === 'left' || direction === 'right')) { setKeyOpen(key, direction === 'right'); return; }
    const next = taskGraphNeighbor(layout, key, direction); if (next) navigate(next);
  };
  const statusLabel = (status: TaskMapStatus) => taskMapStatusLabel(status, copy);
  const count = (value: number) => value.toLocaleString(zh ? 'zh-CN' : 'en-US');
  const stepsLabel = (steps: number) => copy(`${count(steps)} ${steps === 1 ? 'step' : 'steps'}`, `${count(steps)} 步`);
  const foldedLabel = (folded: { steps: number; delegates: number } | undefined) => folded ? [stepsLabel(folded.steps), folded.delegates ? copy(`${count(folded.delegates)} ${folded.delegates === 1 ? 'delegate' : 'delegates'}`, `${count(folded.delegates)} 个委派`) : undefined].filter(Boolean).join(' · ') : '';
  const boxViews = useMemo(() => new Map(layout.boxes.map(box => {
    const node = box.nodeId ? nodesById.get(box.nodeId) : undefined, lane = lanesById.get(box.laneId);
    const members = box.members.map(id => nodesById.get(id)).filter((node): node is TaskMapNode => Boolean(node));
    const name = lane?.kind === 'subagent' ? lane.title : agentName(lane?.provider ?? '');
    const provider = node?.kind === 'delegate' ? sessions.find(session => session.id === node.childSessionId)?.provider ?? lane?.provider : node?.subagent?.provider ?? lane?.provider;
    // A folded box names only its steps: its fork edges already show the delegates (the aria label keeps both).
    const label = box.kind === 'summary' ? [name, box.folded ? stepsLabel(box.folded.steps) : undefined].filter(Boolean).join(' · ') : box.head ? name || node?.label || '' : node?.label ?? '';
    const detail = box.kind === 'summary' ? members.filter(node => node.kind === 'reply').at(-1)?.detail ?? members.at(-1)?.label : box.head ? members.find(node => node.kind === 'prompt')?.detail ?? node?.detail : node?.detail;
    const duration = box.durationMs !== undefined ? formatChatDuration(box.durationMs, false) : undefined;
    const kind = node ? kindLabel(node, zh) : copy('Summary', '摘要');
    return [box.id, { box, label, detail, duration, icon: node ? nodeIcon(node) : 'agents', provider: box.kind === 'summary' || box.head || node?.kind === 'delegate' || node?.kind === 'subagent' ? provider : undefined,
      ariaLabel: [kind, label, detail, box.kind === 'summary' ? foldedLabel(box.folded) : undefined, duration, statusLabel(box.status), name].filter(Boolean).join(' · '),
      output: lane?.kind === 'outputs', nodeKind: node?.kind, foldLabel: box.head && lane?.kind === 'delegate' && box.kind !== 'summary' ? copy(`Fold ${name}'s steps`, `收起 ${name} 的步骤`) : undefined } satisfies BoxView];
  })), [layout, nodesById, lanesById, sessions, zh]);
  const actions = useRef({ activateBox, setKeyOpen, setTabRow });
  actions.current = { activateBox, setKeyOpen, setTabRow };
  const boxViewsRef = useRef(boxViews); boxViewsRef.current = boxViews;
  const onBoxAction = useCallback((id: string, action: 'activate' | 'fold' | 'focus') => {
    if (action === 'focus') actions.current.setTabRow(id);
    else if (action === 'fold') {
      interaction(); const box = boxViewsRef.current.get(id)?.box;
      if (box) { actions.current.setKeyOpen(`lane:${box.laneId}`, false); followBottom.current = false; setPendingRow({ key: box.members[0], align: 'nearest', keyboard: true }); }
    }
    else actions.current.activateBox(id);
  }, []);
  const bindElement = useCallback((id: string, element: HTMLButtonElement | null) => { if (element) rowElements.current.set(id, element); else rowElements.current.delete(id); }, []);
  const clearHighlight = useCallback((id: string) => setHighlight(previous => previous?.key === id ? undefined : previous), []);
  const renderedKeys = new Set([...windowRange.boxes.map(box => box.id), ...windowRange.bands.map(band => band.key), ...(layout.earlier && layout.earlier.bottom > scrollTop - 400 && layout.earlier.top < scrollTop + viewportHeight + 400 ? ['earlier'] : [])]);
  const tabbable = tabRow && renderedKeys.has(tabRow) ? tabRow : windowRange.bands[0]?.key ?? windowRange.boxes[0]?.id ?? (layout.earlier ? 'earlier' : undefined);
  const turnContent = (band: TaskGraphBand, sticky = false) => {
    const phase = graph.phases[band.phase];
    const content = <><strong>{phase?.label}</strong><span className="task-graph-turn-prompt">{phase?.prompt}</span>{!band.open && <small className="task-graph-folded-count">{foldedLabel(band.folded)}</small>}{phase?.elapsedMs !== undefined && <small className="task-graph-box-duration">{formatChatDuration(phase.elapsedMs, false)}</small>}<i className={`task-graph-dot is-${phase?.status}`} aria-hidden="true" /></>;
    if (sticky) return <div className="task-graph-turn"><span className="task-graph-sticky-chevron"><Icon name="chevD" /></span><span className="task-graph-turn-body">{content}</span></div>;
    return <div className="task-graph-turn"><button type="button" className="icon-btn icon-btn-sm task-graph-turn-toggle" tabIndex={-1} aria-label={band.open ? copy('Collapse turn', '收起轮次') : copy('Expand turn', '展开轮次')} aria-expanded={band.open} onClick={() => { interaction(); setKeyOpen(band.key, !band.open); }}><Icon name={band.open ? 'chevD' : 'chevR'} /></button><button type="button" className="task-graph-turn-body" data-nav-key={band.key} ref={element => bindElement(band.key, element)} tabIndex={tabbable === band.key ? 0 : -1} aria-expanded={band.open} aria-label={[phase?.label, phase?.prompt, !band.open ? foldedLabel(band.folded) : undefined, phase ? statusLabel(phase.status) : undefined].filter(Boolean).join(' · ')} onFocus={() => setTabRow(band.key)} onClick={() => activateTurn(band)}>{content}</button></div>;
  };
  const showOverview = viewportHeight > 0 && layout.height > viewportHeight * 1.5;
  const detailsNode = selectedBox?.nodeId ? nodesById.get(selectedBox.nodeId) : undefined;
  if (!root) return <section className="task-map" aria-label={copy('Task map', '任务图')} data-session-id={sessionId} data-visible={visible} data-node-count={0} data-box-count={0} data-edge-count={0} data-columns={0} data-rebuild-count={rebuildCount.current} data-view-ready={false} data-sync={sync ? 'on' : 'off'}><div className="task-map-empty"><p className="note">{copy('This chat no longer exists.', '这个对话已不存在。')}</p><button className="btn" onClick={props.onClose}>{copy('Close', '关闭')}</button></div></section>;
  return <section className="task-map" ref={section} aria-label={copy('Task map', '任务图')} data-session-id={sessionId} data-visible={visible} data-node-count={graph.nodes.length} data-box-count={layout.boxes.length} data-edge-count={layout.edges.length} data-columns={layout.columnX.length} data-view-ready={ready} data-rebuild-count={rebuildCount.current} data-sync={sync ? 'on' : 'off'}
    onKeyDown={event => { if (event.key !== 'Escape' || (!panelOpen && !selected)) return; event.preventDefault(); event.stopPropagation(); if (panelOpen) { setDetailsOpen(false); if (selected && (event.target as HTMLElement).closest('.task-graph-details')) navigate(selected); } else setSelected(undefined); }}>
    <div className="task-map-toolbar">
      <div className="task-map-title"><Icon name="flow" /><strong>{copy('Task map', '任务图')}</strong><span title={root.title}>{root.title}</span></div>
      {graph.lanes.some(lane => lane.status === 'running') && <span className="chip st-running task-map-live">{copy('Live', '实时')}</span>}
      <button className="btn btn-sm task-map-sync" aria-label={copy('Sync with Chat', '与对话同步')} title={copy('Sync with Chat', '与对话同步')} aria-pressed={sync} onClick={() => setSync(value => { try { localStorage.setItem('threadterm.taskMap.sync', value ? 'off' : 'on'); } catch { /* Storage can be unavailable in a fixture. */ } return !value; })}><Icon name="split" />{copy('Sync', '同步')}</button>
      <button className="btn btn-sm task-map-expand" onClick={() => { interaction(); setExpansion(previous => ({ ...initialExpansion(), mode: previous.mode === 'all' ? 'none' : 'all' })); }}>{expansion.mode === 'all' ? copy('Collapse all', '全部收起') : copy('Expand all', '全部展开')}</button>
      <Select className="btn btn-sm task-map-turn" aria-label={copy('Jump to turn', '跳转轮次')} value={turn} onChange={event => { const phase = graph.phases.findIndex(phase => phase.id === event.target.value); if (phase < 0) return; interaction(); setTurn(event.target.value); const key = `turn:${event.target.value}`; openKeys([key]); followBottom.current = false; setPendingRow({ key, align: 'top' }); revealTarget(turnTarget(phase)); }}><option value="">{copy('Jump to turn…', '跳转轮次…')}</option>{graph.phases.map(phase => <option key={phase.id} value={phase.id}>{phase.label}{phase.prompt ? ` · ${phase.prompt}` : ''}</option>)}</Select>
    </div>
    <div className="task-map-summary">{summary.agents.map(agent => <span key={agent.provider}><AgentIcon provider={agent.provider} size={14} />{agentName(agent.provider)}{agent.count > 1 ? ` ×${agent.count}` : ''}</span>)}<span>{copy(`${count(summary.turns)} turns · ${count(summary.steps)} steps`, `${count(summary.turns)} 轮 · ${count(summary.steps)} 步`)}<span className="task-map-summary-secondary">{copy(` · ${count(summary.fileChanges)} file changes`, ` · ${count(summary.fileChanges)} 处文件更改`)}{summary.durationMs !== undefined && ` · ${formatChatDuration(summary.durationMs, false)}`}</span></span></div>
    <div className="task-graph-body" onKeyDownCapture={interaction} onPointerDownCapture={interaction} onWheelCapture={interaction}>
      <div className="task-graph-canvas">
        {layout.columnX.length >= 2 && <div className="task-graph-lanes">{[...laneLabels, ...(layout.outputsColumn !== undefined ? [{ column: layout.outputsColumn, laneId: 'outputs' }] : [])].map(({ column, laneId }) => {
          const lane = lanesById.get(laneId);
          return <div key={`${column}:${laneId}`} className="task-graph-lane-label" data-column={column} data-lane-id={laneId} style={{ left: layout.columnX[column] - scrollLeft, width: layout.boxWidth }} title={lane?.title}>{lane?.provider && <AgentIcon provider={lane.provider} size={14} />}<span>{laneId === 'outputs' ? copy('Outputs', '产出') : lane?.kind === 'subagent' ? lane.title : agentName(lane?.provider ?? '')}</span>{lane?.status && <i className={`task-graph-dot is-${lane.status}`} aria-hidden="true" />}</div>;
        })}</div>}
        <div className="task-graph-scroll-wrap">
          <div className="task-graph-scroll" ref={list} style={{ paddingBottom: bottomInset || undefined }} onKeyDown={onKeyDown} onScroll={event => {
            const element = event.currentTarget, own = ownScroll.current;
            if (!own || Math.abs(element.scrollTop - own.top) > 1 || Math.abs(element.scrollLeft - own.left) > 1) interaction();
            ownScroll.current = undefined; followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
            setScrollTop(element.scrollTop); setScrollLeft(element.scrollLeft);
          }}>
            <div className="task-graph-world" style={{ width: layout.width, height: layout.height }}>
              {layout.earlier && renderedKeys.has('earlier') && <button type="button" className="btn btn-sm task-graph-earlier" data-nav-key="earlier" ref={element => bindElement('earlier', element)} tabIndex={tabbable === 'earlier' ? 0 : -1} style={{ left: TASK_GRAPH_METRICS.padding, top: layout.earlier.top }} onFocus={() => setTabRow('earlier')} onClick={() => { interaction(); setMaxPhases(value => value + 200); }}>{copy(`Show ${graph.hiddenPhases} earlier turns`, `显示更早的 ${graph.hiddenPhases} 轮`)}</button>}
              <svg className="task-graph-edges" width={layout.width} height={layout.height} aria-hidden="true"><defs>{['flow', 'delegate', 'produce'].map(kind => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 Z" className={`task-graph-arrow is-${kind}`} /></marker>)}</defs>{windowRange.edges.map(edge => <path key={edge.id} className={`task-graph-edge${related.edges.has(edge.id) ? ' is-related' : ''}`} data-edge-id={edge.id} data-edge-kind={edge.kind} data-from={edge.from} data-to={edge.to} d={edge.d} markerEnd={`url(#${markerId}-${edge.kind === 'return' ? 'delegate' : edge.kind})`} />)}</svg>
              {windowRange.bands.map(band => <div key={band.key} className={`task-graph-band is-${graph.phases[band.phase]?.status}${marked.has(band.key) ? ' is-in-view' : ''}`} data-band-key={band.key} data-phase={band.phase} data-open={band.open} style={{ top: band.top, height: band.bottom - band.top, width: layout.width }}>{turnContent(band)}</div>)}
              {windowRange.boxes.map(box => <GraphBox key={box.id} view={boxViews.get(box.id)!} selected={selected === box.id} related={related.boxes.has(box.id)} marked={marked.has(box.id)} flashToken={highlight?.key === box.id ? highlight.token : undefined} tabbable={tabbable === box.id} onAction={onBoxAction} bindElement={bindElement} clearHighlight={clearHighlight} />)}
            </div>
            {!layout.bands.length && <div className="task-map-empty"><p className="note" role="status">{Object.values(loads).some(load => load.state === 'loading') || (!items.current.has(sessionId) && loadStates.current[sessionId]?.state !== 'error') ? copy('Loading task map…', '正在加载任务图…') : copy('No activity yet. Send a message in the chat to start the map.', '还没有活动。在对话中发送消息后，这里会显示任务图。')}</p></div>}
          </div>
          {sticky && <div className={`task-graph-sticky-turn${marked.has(sticky.band.key) ? ' is-in-view' : ''}`} aria-hidden="true" style={{ top: sticky.shift }}>{turnContent(sticky.band, true)}</div>}
        </div>
      </div>
      {showOverview && <GraphOverview layout={layout} height={viewportHeight} scrollTop={scrollTop} visible={visible} zh={zh} lanes={layout.columnX.length >= 2} onScroll={top => { interaction(); followBottom.current = false; scrollTo(top); }} />}
      {panelOpen && selectedBox && <aside className="task-graph-details" data-docked={docked} data-box-id={selectedBox.id} aria-label={copy('Step details', '步骤详情')}><header><Icon name={detailsNode ? nodeIcon(detailsNode) : 'agents'} /><strong>{boxViews.get(selectedBox.id)?.label}</strong><button type="button" className="icon-btn icon-btn-sm task-graph-details-close" aria-label={copy('Close details', '关闭详情')} onClick={() => { interaction(); setDetailsOpen(false); navigate(selectedBox.id); }}><Icon name="close" /></button></header>
        {detailsNode ? <TaskMapDetails key={detailsNode.id} node={detailsNode} lane={lanesById.get(detailsNode.laneId)} durationMs={selectedBox.durationMs} target={index.targets.get(detailsNode.id)} sessions={sessions} items={items.current} zh={zh} visible={visible} cache={inspectorCache.current} onOpenSession={props.onOpenSession} onOpenReview={props.onOpenReview} onOpenFile={props.onOpenFile} /> : <div className="task-graph-members">{selectedBox.members.slice(0, 200).map(id => { const node = nodesById.get(id); return node && <button key={id} type="button" className="task-graph-member" data-node-id={id} onClick={() => { interaction(); selectMember(id, sync); }}><Icon name={nodeIcon(node)} /><span><strong>{node.label}</strong><small>{node.detail}</small></span></button>; })}{selectedBox.members.length > 200 && <p className="note">{copy(`${selectedBox.members.length - 200} more`, `还有 ${selectedBox.members.length - 200} 项`)}</p>}</div>}
      </aside>}
    </div>
    {Object.values(loads).some(load => load.state === 'error') && <div className="task-map-load-errors">{Object.entries(loads).filter(([, load]) => load.state === 'error').map(([id, load]) => <div key={id} className="surface-error" title={load.error}>{sessions.find(session => session.id === id)?.title}: {copy('Could not load', '加载失败')}<button className="btn btn-sm" onClick={() => enqueue.current([id], true)}>{copy('Retry', '重试')}</button></div>)}</div>}
    {documentError && <div className="task-map-document-error surface-error">{documentError}<button className="btn btn-sm" onClick={() => reloadDocuments.current()}>{copy('Retry', '重试')}</button></div>}
    {taskSessions.hiddenDelegates > 0 && <p className="note task-map-limit">{copy(`${taskSessions.hiddenDelegates} delegates are outside the map limit.`, `${taskSessions.hiddenDelegates} 个委派超出任务图限制。`)}</p>}
  </section>;
}, (previous, next) => !previous.visible && !next.visible);

interface BoxView {
  box: TaskGraphBox;
  label: string;
  detail?: string;
  duration?: string;
  icon: string;
  provider?: string;
  ariaLabel: string;
  output: boolean;
  nodeKind?: TaskMapNode['kind'];
  foldLabel?: string;
}

const GraphBox = memo(function GraphBox({ view, selected, related, marked, flashToken, tabbable, onAction, bindElement, clearHighlight }: {
  view: BoxView; selected: boolean; related: boolean; marked: boolean; flashToken?: string; tabbable: boolean;
  onAction: (id: string, action: 'activate' | 'fold' | 'focus') => void;
  bindElement: (id: string, element: HTMLButtonElement | null) => void;
  clearHighlight: (id: string) => void;
}) {
  const { box } = view;
  const button = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!flashToken || !button.current) return;
    const element = button.current;
    element.style.animation = 'none'; void element.offsetWidth; element.style.animation = '';
  }, [flashToken]);
  return <><button type="button" className={`task-graph-box${box.kind === 'summary' ? ' is-summary' : ''}${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}${marked ? ' is-in-view' : ''}${box.head ? ' is-head' : ''}${view.output ? ' is-output' : ''}${view.foldLabel ? ' has-fold' : ''}${flashToken ? ' chat-message-highlight' : ''}`}
    data-box-id={box.id} data-box-kind={box.kind} data-node-id={box.nodeId ?? ''} data-node-kind={view.nodeKind ?? ''} data-lane-id={box.laneId} data-phase={box.phase} data-column={box.column} data-status={box.status} data-nav-key={box.id}
    style={{ left: box.x, top: box.y, width: box.width, height: box.height }} tabIndex={tabbable ? 0 : -1} aria-current={selected ? 'true' : undefined} aria-label={view.ariaLabel} title={[view.label, view.detail].filter(Boolean).join('\n')}
    ref={element => { button.current = element; bindElement(box.id, element); }} onFocus={() => onAction(box.id, 'focus')} onClick={() => onAction(box.id, 'activate')} onAnimationEnd={event => { if (event.animationName === 'chat-message-highlight') clearHighlight(box.id); }}>
    <span className="task-graph-box-top">{view.provider ? <AgentIcon provider={view.provider} size={14} /> : <Icon name={view.icon} />}<span className="task-graph-box-label">{view.label}</span><i className={`task-graph-dot is-${box.status}`} aria-hidden="true" /></span><span className="task-graph-box-bottom"><span className="task-graph-box-detail">{view.detail}</span><small className="task-graph-box-duration">{view.duration}</small></span>
  </button>{view.foldLabel && <button type="button" className={`icon-btn icon-btn-sm task-graph-fold${selected ? ' is-selected' : ''}`} style={{ left: box.x + box.width - 28, top: box.y + 10 }} tabIndex={-1} aria-label={view.foldLabel} onClick={() => onAction(box.id, 'fold')}><Icon name="chevU" /></button>}</>;
});

const GraphOverview = memo(function GraphOverview({ layout, height, scrollTop, visible, zh, lanes, onScroll }: {
  layout: TaskGraphLayout; height: number; scrollTop: number; visible: boolean; zh: boolean; lanes: boolean; onScroll: (top: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    const draw = () => {
      const element = canvas.current; if (!element) return;
      const dpr = window.devicePixelRatio || 1;
      element.width = Math.ceil(36 * dpr); element.height = Math.ceil(height * dpr);
      const context = element.getContext('2d'); if (!context) return;
      context.scale(dpr, dpr); context.clearRect(0, 0, 36, height);
      const style = getComputedStyle(element), token = (name: string) => style.getPropertyValue(name).trim();
      const sx = 32 / Math.max(1, layout.width), sy = height / Math.max(1, layout.height);
      context.fillStyle = token('--border');
      for (const band of layout.bands) context.fillRect(2, band.top * sy, 32, 1);
      const colours = new Map(['--st-running', '--st-needs', '--st-failed', '--mint', '--faint'].map(name => [name, token(name)]));
      for (const box of layout.boxes) {
        const colour = box.status === 'running' ? '--st-running' : box.status === 'waiting' ? '--st-needs' : box.status === 'failed' ? '--st-failed' : box.column === layout.outputsColumn ? '--mint' : '--faint';
        context.fillStyle = colours.get(colour)!; context.fillRect(2 + box.x * sx, box.y * sy, Math.max(1, box.width * sx), Math.max(1, box.height * sy));
      }
    };
    draw();
    const observer = new MutationObserver(records => { if (records.some(record => record.attributeName === 'class' || record.attributeName === 'style' || record.attributeName?.startsWith('data-'))) draw(); });
    observer.observe(document.documentElement, { attributes: true });
    document.addEventListener('visibilitychange', draw);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', draw); };
  }, [layout, height, visible, zh]);
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onScroll((event.clientY - rect.top) / Math.max(1, rect.height) * layout.height - height / 2);
  };
  return <div className="task-graph-overview" style={{ marginTop: lanes ? 24 : 0, height }} aria-hidden="true" onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); seek(event); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) seek(event); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
    <canvas ref={canvas} style={{ width: 36, height }} /><div className="task-graph-overview-viewport" style={{ top: scrollTop / Math.max(1, layout.height) * height, height: Math.min(height, height / Math.max(1, layout.height) * height) }} />
  </div>;
});

function kindLabel(node: TaskMapNode, zh: boolean): string {
  const copy = (en: string, cn: string) => zh ? cn : en;
  return ({ prompt: copy('Prompt', '提示'), plan: copy('Plan', '计划'), tools: copy('Tools', '工具'), delegate: copy('Delegate', '委派'), subagent: copy('Subagent', '子代理'), approval: copy('Approval', '审批'), question: copy('Question', '问题'), error: copy('Error', '错误'), reply: copy('Reply', '回复'), files: copy('Files changed', '文件更改'), document: copy('Document', '文档') })[node.kind];
}

function nodeIcon(node: TaskMapNode): string {
  if (node.kind === 'tools') return ({ explore: 'search', command: 'terminal', edit: 'file', browser: 'globe', mcp: 'plug', delegation: 'agents', tool: 'wrench' })[node.step ?? 'tool'];
  return ({ prompt: 'agents', plan: 'check', delegate: 'agents', subagent: 'spark', approval: 'shield', question: 'info', error: 'close', reply: 'check', files: 'file', document: 'file' })[node.kind];
}

export default TaskMapView;
