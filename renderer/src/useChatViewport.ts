import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';

type Viewport = { top: number; follow: boolean };
const viewports = new Map<string, Viewport>();
const FOLLOW_THRESHOLD = 24;

/** User inspection must stop follow before a disclosure changes layout. */
export function useChatViewport(sessionId: string, snapshotReady: boolean, logRef: RefObject<HTMLDivElement | null>, contentRef: RefObject<HTMLDivElement | null>) {
  const followRef = useRef(true);
  const inspectingRef = useRef(false);
  const restoredRef = useRef<{ sessionId: string; pending: boolean } | undefined>(undefined);
  const [paused, setPaused] = useState(false);

  const remember = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    if (!viewports.has(sessionId) && viewports.size >= 50) viewports.delete(viewports.keys().next().value!);
    viewports.set(sessionId, { top: log.scrollTop, follow: followRef.current });
  }, [sessionId, logRef]);

  const setFollowing = useCallback((follow: boolean) => {
    followRef.current = follow;
    setPaused(!follow);
    if (logRef.current) logRef.current.style.overflowAnchor = follow ? 'none' : 'auto';
  }, [logRef]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const restore = restoredRef.current;
    if (restore?.sessionId === sessionId && !snapshotReady) {
      restoredRef.current = { sessionId, pending: true };
      return;
    }
    if (restore?.sessionId === sessionId && !restore.pending) return;
    const saved = viewports.get(sessionId);
    inspectingRef.current = false;
    setFollowing(saved?.follow ?? true);
    log.scrollTop = !saved || saved.follow ? log.scrollHeight : saved.top;
    // Readiness is tied to the confirmed snapshot's session, not items.length:
    // a new session briefly renders the previous session's items before reset.
    restoredRef.current = { sessionId, pending: !snapshotReady };
  }, [sessionId, snapshotReady, logRef, setFollowing]);

  useLayoutEffect(() => {
    const log = logRef.current, content = contentRef.current;
    if (!log || !content) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) log.scrollTop = log.scrollHeight;
      if (!restoredRef.current?.pending) remember();
    });
    observer.observe(log);
    observer.observe(content);
    return () => observer.disconnect();
  }, [logRef, contentRef, remember]);

  const followLatest = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    inspectingRef.current = false;
    setFollowing(true);
    log.focus({ preventScroll: true });
    // An immediate jump avoids smooth-scroll frames fighting live output.
    log.scrollTop = log.scrollHeight;
    remember();
  }, [logRef, remember, setFollowing]);

  const navigateToMessage = useCallback((id: string) => {
    const log = logRef.current;
    const message = Array.from(log?.querySelectorAll<HTMLElement>('[data-chat-item]') ?? []).find(element => element.dataset.chatItem === id);
    if (!log || !message) return;
    inspectingRef.current = true;
    setFollowing(false);
    log.scrollTop += message.getBoundingClientRect().top - log.getBoundingClientRect().top - 48;
    message.tabIndex = -1;
    message.focus({ preventScroll: true });
    message.classList.remove('chat-message-highlight');
    void message.offsetWidth;
    message.classList.add('chat-message-highlight');
    remember();
  }, [logRef, remember, setFollowing]);

  const pauseForDisclosure = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const collapse = target?.closest('[data-chat-collapse]');
    const summary = target?.closest('summary');
    if (!collapse && (!summary || target?.closest('button, input, textarea, a, [contenteditable="true"]'))) return;
    inspectingRef.current = true;
    setFollowing(false);
    remember();
  };

  const onScroll = () => {
    const log = logRef.current;
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_THRESHOLD;
    setFollowing(nearBottom && !inspectingRef.current);
    if (!restoredRef.current?.pending) remember();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : undefined;
    // Escape belongs to editing/approval/menu surfaces; only transcript
    // navigation can use it to resume follow.
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .chat-question-wrapper, .chat-part.approval')) return;
    if (['Enter', ' '].includes(event.key) && target?.closest('summary') && !target.closest('button, a')) {
      inspectingRef.current = true;
      setFollowing(false);
      remember();
      return;
    }
    if (event.key === 'Escape' && paused && (!target?.closest('button, a') || target.closest('.chat-back-to-bottom'))) {
      event.preventDefault();
      event.stopPropagation();
      followLatest();
    } else if (['End', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home'].includes(event.key) && !target?.closest('button, a, summary')) {
      inspectingRef.current = false;
    }
  };

  return { paused, followRef, followLatest, navigateToMessage, pauseForDisclosure, onScroll, onKeyDown,
    inspect: () => { inspectingRef.current = true; setFollowing(false); remember(); },
    onWheel: () => { inspectingRef.current = false; },
    onTouchStart: () => { inspectingRef.current = false; },
    onPointerDown: (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === logRef.current) inspectingRef.current = false;
    },
  };
}
