import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageSnapshot } from '../../../stores/liveGridStore';

type CardMessageListProps = {
  snapshots: MessageSnapshot[];
};

// Module-level set to track which snapshot IDs have been fully animated.
// Persists across re-renders; resets on page reload (intentional).
// Capped to prevent unbounded growth during long sessions.
const ANIMATED_IDS_MAX_SIZE = 500;
const animatedIds = new Set<string>();

function trackAnimatedId(id: string) {
  if (animatedIds.size >= ANIMATED_IDS_MAX_SIZE) {
    // Evict oldest entries (first inserted) to stay within budget
    const iter = animatedIds.values();
    for (let i = 0; i < ANIMATED_IDS_MAX_SIZE / 2; i++) {
      const { value } = iter.next();
      if (value !== undefined) animatedIds.delete(value);
    }
  }
  animatedIds.add(id);
}

const CURSOR_CLASS =
  'inline-block w-[2px] h-[1em] bg-current ml-0.5 align-text-bottom animate-[cursor-blink_1s_ease-in-out_infinite]';

/** Extract a short human-readable label from raw tool text. */
function extractToolLabel(text: string): string {
  if (text.startsWith('🔧 ')) return text.slice(2).split('\n')[0].slice(0, 30);
  if (text.startsWith('$ ')) return 'running command…';
  if (text.toLowerCase().startsWith('command:')) return 'running command…';
  return text.split('\n')[0].slice(0, 30);
}

/** Collapse consecutive tool snapshots into a single "working…" indicator. */
function collapseToolRuns(snaps: MessageSnapshot[]): MessageSnapshot[] {
  const result: MessageSnapshot[] = [];
  let toolCount = 0;

  for (const snap of snaps) {
    if (snap.kind === 'tool') {
      toolCount++;
      const toolSnap: MessageSnapshot = {
        ...snap,
        id: `tool-group-${snap.timestamp}`,
        text: toolCount > 1 ? `working… (${toolCount} steps)` : 'working…',
      };
      if (result.length > 0 && result[result.length - 1].kind === 'tool') {
        result[result.length - 1] = toolSnap;
      } else {
        result.push(toolSnap);
      }
    } else {
      toolCount = 0;
      result.push(snap);
    }
  }
  return result;
}

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

  // History messages — render immediately without animation
  if (snap.fromHistory) {
    return <span>{snap.text}</span>;
  }

  // Already animated — render full text immediately
  if (animatedIds.has(snap.id)) {
    return <span>{snap.text}</span>;
  }

  // New completed message — animate it
  return <TypewriterText text={snap.text} onComplete={() => trackAnimatedId(snap.id)} />;
}

function MessageBubble({ snap }: { snap: MessageSnapshot }) {
  const isUser = snap.kind === 'user';
  const isTool = snap.kind === 'tool';
  const isError = snap.kind === 'error';
  const isAssistant = snap.kind === 'assistant' || snap.kind === 'system';

  if (isTool) {
    const label = extractToolLabel(snap.text);
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <span className="shrink-0 text-[9px] text-muted-foreground/50">⚙</span>
        <span className="truncate text-[9px] text-muted-foreground/50 italic">
          {label}
        </span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md bg-red-500/8 px-2.5 py-1.5 dark:bg-red-500/10">
        <p className="break-words whitespace-pre-wrap text-[11px] leading-relaxed text-red-600 dark:text-red-400">
          {snap.text}
        </p>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 px-3 py-1.5 dark:bg-primary/80">
          <p className="break-words whitespace-pre-wrap text-[11px] leading-relaxed text-primary-foreground">
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
          <p className="break-words whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/85">
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
        <p className="break-words whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/85">
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

  const displaySnapshots = useMemo(() => collapseToolRuns(snapshots), [snapshots]);

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
  }, [displaySnapshots, scrollToBottom]);

  if (snapshots.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/50">
        {t('liveGrid.noMessages')}
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto px-2.5 py-2 space-y-1.5 scroll-smooth"
      >
        {displaySnapshots.map((snap) => (
          <MessageBubble key={snap.id} snap={snap} />
        ))}
      </div>
    </div>
  );
}
