import { useRef, useEffect, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageSnapshot } from '../../../stores/liveGridStore';

type CardMessageListProps = {
  snapshots: MessageSnapshot[];
};

// Module-level set to track which snapshot IDs have been fully animated.
// Persists across re-renders; resets on page reload (intentional).
const animatedIds = new Set<string>();

const CURSOR_CLASS =
  'inline-block w-[2px] h-[1em] bg-current ml-0.5 align-text-bottom animate-[cursor-blink_1s_ease-in-out_infinite]';

function TypewriterText({ text, onComplete }: { text: string; onComplete: () => void }) {
  const [displayed, setDisplayed] = useState('');
  const indexRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    indexRef.current = 0;
    setDisplayed('');

    // Adapt speed: aim for ~1.3s total regardless of length
    const charsPerTick = Math.max(1, Math.ceil(text.length / 80));

    function tick() {
      const next = Math.min(indexRef.current + charsPerTick, text.length);
      indexRef.current = next;
      setDisplayed(text.slice(0, next));
      if (next < text.length) {
        timeoutRef.current = setTimeout(tick, 16);
      } else {
        onCompleteRef.current();
      }
    }

    timeoutRef.current = setTimeout(tick, 16);
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, [text]);

  return (
    <span>
      {displayed}
      {displayed.length < text.length && <span className={CURSOR_CLASS} />}
    </span>
  );
}

function AnimatedAssistantMessage({ snap }: { snap: MessageSnapshot }) {
  // Streaming message — show text as-is with blinking cursor
  if (snap.streaming) {
    return (
      <span>
        {snap.text}
        <span className={CURSOR_CLASS} />
      </span>
    );
  }

  // Already animated — render full text immediately
  if (animatedIds.has(snap.id)) {
    return <span>{snap.text}</span>;
  }

  // New completed message — animate it
  return <TypewriterText text={snap.text} onComplete={() => animatedIds.add(snap.id)} />;
}

function MessageBubble({ snap }: { snap: MessageSnapshot }) {
  const isUser = snap.kind === 'user';
  const isTool = snap.kind === 'tool';
  const isError = snap.kind === 'error';
  const isAssistant = snap.kind === 'assistant' || snap.kind === 'system';

  if (isTool) {
    return (
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-[10px] text-muted-foreground/70">⚙</span>
        <span className="text-[10px] leading-snug text-muted-foreground/70 truncate">
          {snap.text}
        </span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md bg-red-500/8 px-2.5 py-1.5 dark:bg-red-500/10">
        <p className="text-[11px] leading-relaxed text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">
          {snap.text}
        </p>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 px-3 py-1.5 dark:bg-primary/80">
          <p className="text-[11px] leading-relaxed text-primary-foreground break-words whitespace-pre-wrap">
            {snap.text}
          </p>
        </div>
      </div>
    );
  }

  // Assistant / system — use animated rendering
  if (isAssistant) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%]">
          <p className="text-[11px] leading-relaxed text-foreground/85 break-words whitespace-pre-wrap">
            <AnimatedAssistantMessage snap={snap} />
          </p>
        </div>
      </div>
    );
  }

  // Fallback (shouldn't happen)
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <p className="text-[11px] leading-relaxed text-foreground/85 break-words whitespace-pre-wrap">
          {snap.text}
        </p>
      </div>
    </div>
  );
}

export default function CardMessageList({ snapshots }: CardMessageListProps) {
  const { t } = useTranslation('common');
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Track whether user has scrolled away from bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 40;
    isAutoScrollRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll on new snapshots if near bottom
  useEffect(() => {
    if (isAutoScrollRef.current) {
      scrollToBottom();
    }
  }, [snapshots, scrollToBottom]);

  if (snapshots.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/50">
        {t('liveGrid.noMessages')}
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-2.5 py-2 space-y-1.5 scroll-smooth"
      >
        {snapshots.map((snap) => (
          <MessageBubble key={snap.id} snap={snap} />
        ))}
      </div>
    </div>
  );
}
