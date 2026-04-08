import { useRef, useEffect } from 'react';
import type { MessageSnapshot } from '../../../stores/liveGridStore';

type MiniMessageStreamProps = {
  snapshots: MessageSnapshot[];
};

function kindPrefix(kind: MessageSnapshot['kind']): { symbol: string; className: string } {
  switch (kind) {
    case 'user':
      return { symbol: '>', className: 'text-blue-500' };
    case 'assistant':
      return { symbol: '◆', className: 'text-foreground' };
    case 'tool':
      return { symbol: '⚙', className: 'text-muted-foreground' };
    case 'error':
      return { symbol: '✗', className: 'text-red-500' };
    default:
      return { symbol: '●', className: 'text-muted-foreground' };
  }
}

export default function MiniMessageStream({ snapshots }: MiniMessageStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const displaySnapshots = snapshots.slice(-8);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displaySnapshots.length]);

  if (displaySnapshots.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
        No messages yet
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={scrollRef} className="h-full overflow-y-auto px-2.5 py-1.5 space-y-0.5">
        {displaySnapshots.map((snap) => {
          const { symbol, className } = kindPrefix(snap.kind);
          return (
            <div key={snap.id} className="flex gap-1.5 text-[11px] leading-relaxed">
              <span className={`shrink-0 font-mono ${className}`}>{symbol}</span>
              <span className={`min-w-0 break-words ${snap.kind === 'error' ? 'text-red-500' : 'text-foreground/80'}`}>
                {snap.text}
                {snap.streaming && (
                  <span className="inline-block ml-0.5 animate-pulse text-muted-foreground">...</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {/* Bottom fade gradient */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-card to-transparent" />
    </div>
  );
}
