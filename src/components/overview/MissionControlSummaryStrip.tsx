import { AlertCircle, Bot, CheckCircle2, PauseCircle, ShieldCheck } from 'lucide-react';
import type { MissionControlSurfaceTarget } from '../../lib/mission-control';

interface MissionControlSummaryStripProps {
  pendingApprovals: number;
  activeAttentionItems: number;
  runningTasks: number;
  queuedTasks: number;
  pendingReviewTasks: number;
  acceptedResults: number;
  onFocusSurface?: (target: MissionControlSurfaceTarget) => void;
}

const CARDS = [
  {
    key: 'approvals',
    label: 'Pending approvals',
    target: 'approval-inbox',
    icon: PauseCircle,
    tone: 'text-amber-600 bg-amber-500/10',
  },
  {
    key: 'attention',
    label: 'Attention items',
    target: 'attention-inbox',
    icon: AlertCircle,
    tone: 'text-red-500 bg-red-500/10',
  },
  {
    key: 'running',
    label: 'Running tasks',
    target: 'task-running',
    icon: Bot,
    tone: 'text-blue-500 bg-blue-500/10',
  },
  {
    key: 'queued',
    label: 'Queued tasks',
    target: 'task-backlog',
    icon: CheckCircle2,
    tone: 'text-emerald-600 bg-emerald-500/10',
  },
  {
    key: 'review',
    label: 'Pending review',
    target: 'review-queue',
    icon: ShieldCheck,
    tone: 'text-purple-600 bg-purple-500/10',
  },
  {
    key: 'results',
    label: 'Result inbox',
    target: 'result-inbox',
    icon: CheckCircle2,
    tone: 'text-emerald-600 bg-emerald-500/10',
  },
] as const;

export default function MissionControlSummaryStrip({
  pendingApprovals,
  activeAttentionItems,
  runningTasks,
  queuedTasks,
  pendingReviewTasks,
  acceptedResults,
  onFocusSurface,
}: MissionControlSummaryStripProps) {
  const values = {
    approvals: pendingApprovals,
    attention: activeAttentionItems,
    running: runningTasks,
    queued: queuedTasks,
    review: pendingReviewTasks,
    results: acceptedResults,
  } as const;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {CARDS.map(({ key, label, target, icon: Icon, tone }) => {
        const count = values[key];
        const isActionable = count > 0 && Boolean(onFocusSurface);

        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              if (!isActionable) return;
              onFocusSurface?.(target);
            }}
            disabled={!isActionable}
            className={`rounded-2xl border border-border/60 bg-card/80 p-4 text-left shadow-sm transition-colors ${
              isActionable
                ? 'hover:border-border hover:bg-card'
                : 'cursor-default'
            }`}
          >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
              <div className="mt-2 text-2xl font-semibold text-foreground">{count}</div>
            </div>
            <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${tone}`}>
              <Icon className="h-5 w-5" />
            </div>
          </div>
          </button>
        );
      })}
    </div>
  );
}
