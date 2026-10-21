import { useEffect, useRef, type RefObject } from 'react';
import type { ChatItem } from '@threadterm/protocol';
import type { ChatViewState, TaskFlowChatTarget } from './taskMapTypes';

export interface ChatHandle { shown(): boolean; reveal(target: TaskFlowChatTarget): boolean }
type ViewListener = (state: ChatViewState | undefined) => void;
type HandleState = { handle: ChatHandle; state?: ChatViewState; revision: number };
type ChatRegistry = {
  handles: Map<ChatHandle, HandleState>;
  watchers: Set<{ listener: ViewListener }>;
  watchListeners: Set<(watched: boolean) => void>;
  delivered?: ChatViewState;
};
const sessions = new Map<string, ChatRegistry>();
const handles = new Map<ChatHandle, { sessionId: string; entry: HandleState }>();
let revision = 0;

function registry(sessionId: string): ChatRegistry {
  let chat = sessions.get(sessionId);
  if (!chat) {
    chat = { handles: new Map(), watchers: new Set(), watchListeners: new Set() };
    sessions.set(sessionId, chat);
  }
  return chat;
}
function prune(sessionId: string, chat: ChatRegistry): void {
  if (!chat.handles.size && !chat.watchers.size && !chat.watchListeners.size) sessions.delete(sessionId);
}
function equalState(a: ChatViewState | undefined, b: ChatViewState | undefined): boolean {
  if (!a || !b) return a === b;
  const equal = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index]);
  return a.sessionId === b.sessionId && a.following === b.following && equal(a.items, b.items) && equal(a.tools, b.tools) && equal(a.turns, b.turns);
}
function deliver(chat: ChatRegistry): void {
  let latest: HandleState | undefined;
  for (const entry of chat.handles.values()) {
    if (entry.state && entry.handle.shown() && (!latest || entry.revision > latest.revision)) latest = entry;
  }
  const next = latest?.state;
  if (equalState(chat.delivered, next)) return;
  chat.delivered = next;
  for (const { listener } of [...chat.watchers]) listener(next);
}

export function registerChatHandle(sessionId: string, handle: ChatHandle): () => void {
  const chat = registry(sessionId);
  const entry: HandleState = { handle, revision: 0 };
  chat.handles.set(handle, entry);
  handles.set(handle, { sessionId, entry });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (chat.handles.get(handle) !== entry) return;
    chat.handles.delete(handle);
    handles.delete(handle);
    deliver(chat);
    prune(sessionId, chat);
  };
}

export function publishChatView(handle: ChatHandle, state: ChatViewState | undefined): void {
  const registration = handles.get(handle);
  if (!registration) return;
  registration.entry.state = state ? { sessionId: registration.sessionId, items: [...state.items], tools: [...state.tools], turns: [...state.turns], following: state.following } : undefined;
  registration.entry.revision = ++revision;
  deliver(registry(registration.sessionId));
}

export function watchChatView(sessionId: string, listener: ViewListener): () => void {
  const chat = registry(sessionId);
  deliver(chat);
  const subscription = { listener };
  const first = !chat.watchers.size;
  chat.watchers.add(subscription);
  listener(chat.delivered);
  if (first) for (const changed of [...chat.watchListeners]) changed(true);
  return () => {
    if (!chat.watchers.delete(subscription)) return;
    if (!chat.watchers.size) for (const changed of [...chat.watchListeners]) changed(false);
    prune(sessionId, chat);
  };
}

export function chatViewWatched(sessionId: string): boolean { return Boolean(sessions.get(sessionId)?.watchers.size); }

export function onChatViewWatch(sessionId: string, listener: (watched: boolean) => void): () => void {
  const chat = registry(sessionId);
  chat.watchListeners.add(listener);
  listener(chatViewWatched(sessionId));
  return () => { chat.watchListeners.delete(listener); prune(sessionId, chat); };
}

/** True when a Chat of `sessionId` is on screen. */
export function chatShown(sessionId: string): boolean {
  const chat = sessions.get(sessionId);
  return Boolean(chat && [...chat.handles.keys()].some(handle => handle.shown()));
}

export function revealInChat(target: TaskFlowChatTarget): boolean {
  const chat = sessions.get(target.sessionId);
  if (!chat) return false;
  // The Chat whose state the flow shows (latest publish) goes first, so a click scrolls the pane that marked the rows.
  const ordered = [...chat.handles.values()].sort((a, b) => b.revision - a.revision).map(entry => entry.handle);
  for (const handle of ordered) if (handle.shown() && handle.reveal(target)) return true;
  return false;
}

let pendingReveal: number | undefined;
let revealGeneration = 0;
/** Reveals now, or calls `open` and retries for ~1 s; `onFailed` runs when nothing could be revealed. */
export function openAndRevealInChat(target: TaskFlowChatTarget, open?: (sessionId: string) => void, onFailed?: () => void): void {
  const generation = ++revealGeneration;
  if (pendingReveal !== undefined) cancelAnimationFrame(pendingReveal);
  pendingReveal = undefined;
  if (revealInChat(target)) return;
  if (chatShown(target.sessionId)) { onFailed?.(); return; }
  open?.(target.sessionId);
  let frames = 0;
  const retry = () => {
    pendingReveal = undefined;
    if (generation !== revealGeneration || revealInChat(target)) return;
    if (++frames >= 60) { onFailed?.(); return; }
    pendingReveal = requestAnimationFrame(retry);
  };
  if (generation === revealGeneration) pendingReveal = requestAnimationFrame(retry);
}

const selectors = '[data-chat-item], [data-tool-id], [data-chat-turn], .chat-tool-activity-card';
function shown(log: HTMLDivElement | null): log is HTMLDivElement {
  if (!log?.isConnected || !log.getClientRects().length || log.clientHeight <= 0) return false;
  // A fullscreen pane hides the other panes with `visibility: hidden`; they keep their layout boxes.
  return typeof log.checkVisibility === 'function' ? log.checkVisibility({ visibilityProperty: true }) : getComputedStyle(log).visibility !== 'hidden';
}
function rendered(element: HTMLElement): boolean { return element.getClientRects().length > 0; }

export function useChatFlowSync(sessionId: string, logRef: RefObject<HTMLDivElement | null>, contentRef: RefObject<HTMLDivElement | null>,
  items: readonly ChatItem[], viewport: { pauseForNavigation(): void; followRef: { current: boolean } }): { topItemId(): string | undefined } {
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const rescanRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    let revealFrame: number | undefined;
    let scanFrame: number | undefined;
    let updateFrame: number | undefined;
    let stopWatching: (() => void) | undefined;
    const handle: ChatHandle = {
      shown: () => shown(logRef.current),
      reveal: target => {
        const log = logRef.current, content = contentRef.current;
        if (!shown(log) || !content) return false;
        // A settled turn renders one item twice: an activity copy (thinking, inside the "Activity" disclosure) and a
        // response copy (reply text, tools drawer). Prefer the response copy, rendered first; open disclosures last.
        const find = (attribute: string, id: string | undefined) => {
          if (id === undefined) return null;
          const matches = [...content.querySelectorAll<HTMLElement>(`[${attribute}="${CSS.escape(id)}"]`)];
          const activity = (element: HTMLElement) => Boolean(element.closest('details.codex-work'));
          return matches.find(element => rendered(element) && !activity(element)) ?? matches.find(element => !activity(element))
            ?? matches.find(rendered) ?? matches[0] ?? null;
        };
        const element = find('data-tool-id', target.toolId) ?? find('data-chat-item', target.itemId) ?? find('data-chat-turn', target.turnItemId);
        if (!element) return false;
        for (let parent = element.parentElement; parent && parent !== log; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open) parent.open = true;
        }
        if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
        revealFrame = requestAnimationFrame(() => {
          revealFrame = undefined;
          if (!shown(log) || logRef.current !== log || !element.isConnected) return;
          viewportRef.current.pauseForNavigation();
          log.scrollTop += element.getBoundingClientRect().top - log.getBoundingClientRect().top - 48;
          element.tabIndex = -1;
          element.focus({ preventScroll: true });
          element.classList.remove('chat-message-highlight');
          void element.offsetWidth;
          element.classList.add('chat-message-highlight');
        });
        return true;
      },
    };
    const unregister = registerChatHandle(sessionId, handle);
    const unwatch = onChatViewWatch(sessionId, watched => {
      stopWatching?.();
      stopWatching = undefined;
      if (!watched) return;
      const log = logRef.current, content = contentRef.current;
      if (!log || !content) return;
      let observing = true;
      const observed = new Set<HTMLElement>();
      const intersecting = new Set<HTMLElement>();
      const update = () => {
        updateFrame = undefined;
        if (!observing) return;
        if (!shown(log)) { publishChatView(handle, undefined); return; }
        const bounds = log.getBoundingClientRect();
        const state: ChatViewState = { sessionId, items: [], tools: [], turns: [], following: viewportRef.current.followRef.current };
        const tools = new Set<string>();
        const visible = [...intersecting].filter(element => {
          if (!element.isConnected || !rendered(element)) return false;
          const rect = element.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
        }).sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        for (const element of visible) {
          if (element.dataset.chatItem !== undefined) state.items.push(element.dataset.chatItem);
          if (element.dataset.chatTurn !== undefined) state.turns.push(element.dataset.chatTurn);
          if (element.dataset.toolId !== undefined) tools.add(element.dataset.toolId);
          if (element.matches('.chat-tool-activity-card') && element.querySelector('details.chat-tool-activity:not([open])')) {
            for (const tool of element.querySelectorAll<HTMLElement>('[data-tool-id]')) if (tool.dataset.toolId !== undefined) tools.add(tool.dataset.toolId);
          }
        }
        state.tools = [...tools];
        publishChatView(handle, state);
      };
      const schedule = () => { if (observing && updateFrame === undefined) updateFrame = requestAnimationFrame(update); };
      const intersection = new IntersectionObserver(entries => {
        if (!observing) return;
        for (const entry of entries) {
          if (entry.isIntersecting) intersecting.add(entry.target as HTMLElement);
          else intersecting.delete(entry.target as HTMLElement);
        }
        schedule();
      }, { root: log });
      const scan = () => {
        scanFrame = undefined;
        if (!observing) return;
        const current = new Set(content.querySelectorAll<HTMLElement>(selectors));
        for (const element of observed) if (!current.has(element)) {
          intersection.unobserve(element); observed.delete(element); intersecting.delete(element);
        }
        for (const element of current) if (!observed.has(element)) { observed.add(element); intersection.observe(element); }
        schedule();
      };
      const rescan = () => { if (observing && scanFrame === undefined) scanFrame = requestAnimationFrame(scan); };
      rescanRef.current = rescan;
      const resize = new ResizeObserver(schedule);
      resize.observe(log);
      log.addEventListener('scroll', schedule, { passive: true });
      scan();
      stopWatching = () => {
        observing = false;
        intersection.disconnect(); resize.disconnect();
        log.removeEventListener('scroll', schedule);
        if (scanFrame !== undefined) cancelAnimationFrame(scanFrame);
        if (updateFrame !== undefined) cancelAnimationFrame(updateFrame);
        scanFrame = updateFrame = undefined;
        rescanRef.current = undefined;
        publishChatView(handle, undefined);
      };
    });
    return () => {
      unwatch(); stopWatching?.();
      if (revealFrame !== undefined) cancelAnimationFrame(revealFrame);
      unregister();
    };
  }, [sessionId, logRef, contentRef]);

  useEffect(() => { rescanRef.current?.(); }, [items]);
  return { topItemId: () => {
    const log = logRef.current, content = contentRef.current;
    if (!shown(log) || !content) return undefined;
    const top = log.getBoundingClientRect().top + 8;
    // Subagent transcripts render their own items inside the parent Chat; the map only knows the parent's.
    return [...content.querySelectorAll<HTMLElement>('[data-chat-item]')].find(element => rendered(element) && !element.closest('.chat-subagent-transcript') && element.getBoundingClientRect().bottom > top)?.dataset.chatItem;
  } };
}
