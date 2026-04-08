import { useSessionStatusStore } from '../../stores/sessionStatusStore';

export default function SessionStatusCounts() {
  const statuses = useSessionStatusStore((s) => s.statuses);

  let attentionCount = 0;
  let processingCount = 0;

  for (const entry of Object.values(statuses)) {
    if (entry.status === 'needs_attention') attentionCount++;
    else if (entry.status === 'processing') processingCount++;
  }

  if (attentionCount === 0 && processingCount === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {attentionCount > 0 ? (
        <span className="flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
          {attentionCount}
        </span>
      ) : null}
      {processingCount > 0 ? (
        <span className="flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" style={{ animation: 'spin 1s linear infinite' }} />
          {processingCount}
        </span>
      ) : null}
    </div>
  );
}
