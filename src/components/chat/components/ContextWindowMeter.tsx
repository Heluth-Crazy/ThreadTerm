import { useMemo, useState } from 'react';

export interface TokenBudget {
  used: number;
  total: number;
}

interface ContextWindowMeterProps {
  tokenBudget: TokenBudget | null;
}

export default function ContextWindowMeter({ tokenBudget }: ContextWindowMeterProps) {
  const [hovered, setHovered] = useState(false);

  const { percentage, colorClass, barColor } = useMemo(() => {
    if (!tokenBudget || tokenBudget.total <= 0) {
      return { percentage: 0, colorClass: '', barColor: '' };
    }
    const pct = Math.min((tokenBudget.used / tokenBudget.total) * 100, 100);
    let color: string;
    let bar: string;
    if (pct >= 80) {
      color = 'text-red-500';
      bar = 'bg-red-500';
    } else if (pct >= 50) {
      color = 'text-yellow-500';
      bar = 'bg-yellow-500';
    } else {
      color = 'text-emerald-500';
      bar = 'bg-emerald-500';
    }
    return { percentage: pct, colorClass: color, barColor: bar };
  }, [tokenBudget]);

  if (!tokenBudget || tokenBudget.total <= 0) return null;

  const formattedUsed = tokenBudget.used.toLocaleString();
  const formattedTotal = tokenBudget.total.toLocaleString();
  const pctDisplay = percentage.toFixed(1);

  return (
    <div className="px-3 pb-1.5 pt-1">
      {/* Progress bar */}
      <div
        className="relative h-1.5 w-full cursor-default overflow-hidden rounded-full bg-muted/60"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${barColor}`}
          style={{
            width: `${percentage}%`,
            transition: 'width 600ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />

        {/* Tooltip */}
        {hovered && (
          <div
            className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border/60 bg-popover px-2.5 py-1 text-[11px] text-popover-foreground shadow-md"
            style={{ pointerEvents: 'none' }}
          >
            {formattedUsed} / {formattedTotal} tokens used ({pctDisplay}%)
          </div>
        )}
      </div>

      {/* Warning banner */}
      {percentage >= 80 && (
        <div className={`mt-1 flex items-center gap-1.5 rounded-md bg-red-500/10 px-2 py-1 text-[11px] ${colorClass}`}>
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4zm.75 7a.75.75 0 110-1.5.75.75 0 010 1.5z" />
          </svg>
          <span>Context window almost full. Use <code className="rounded bg-red-500/10 px-1 font-mono text-[10px]">/compact</code> to summarize.</span>
        </div>
      )}
    </div>
  );
}
