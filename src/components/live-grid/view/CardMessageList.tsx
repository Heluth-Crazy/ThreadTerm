import { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageSnapshot } from '../../../stores/liveGridStore';

type CardMessageListProps = {
  snapshots: MessageSnapshot[];
};

function MessageBubble({ snap }: { snap: MessageSnapshot }) {
  const isUser = snap.kind === 'user';
  const isTool = snap.kind === 'tool';
  const isError = snap.kind === 'error';

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

  // Assistant / system
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <p className="text-[11px] leading-relaxed text-foreground/85 break-words whitespace-pre-wrap">
          {snap.text}
          {snap.streaming && (
            <span className="inline-block ml-0.5 w-[5px] h-[13px] align-text-bottom bg-foreground/70 animate-[cursor-blink_1s_steps(2)_infinite]" />
          )}
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
