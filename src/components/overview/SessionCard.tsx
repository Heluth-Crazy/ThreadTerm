import { useMemo } from 'react';
import { useSessionStatusStore, type SessionRuntimeStatus } from '../../stores/sessionStatusStore';
import type { Project, ProjectSession } from '../../types/app';

export interface SessionCardProps {
  session: ProjectSession;
  project: Project;
  onClick: () => void;
}

function formatRelativeTime(dateStr?: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function StatusDot({ status }: { status: SessionRuntimeStatus }) {
  switch (status) {
    case 'needs_attention':
      return <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />;
    case 'processing':
      return (
        <span className="inline-block h-2 w-2 rounded-full border-[1.5px] border-blue-500 border-t-transparent" style={{ animation: 'spin 0.8s linear infinite' }} />
      );
    case 'completed':
      return <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />;
    default:
      return <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />;
  }
}

export default function SessionCard({ session, project, onClick }: SessionCardProps) {
  const getStatus = useSessionStatusStore((s) => s.getStatus);
  const statusEntry = getStatus(session.id);
  const provider = session.__provider ?? 'claude';

  const borderClass = useMemo(() => {
    if (statusEntry.status === 'needs_attention') return 'ring-2 ring-red-500/50 animate-pulse';
    if (statusEntry.status === 'processing') return 'ring-1 ring-blue-500/30';
    return '';
  }, [statusEntry.status]);

  const timeLabel = formatRelativeTime(session.lastActivity || session.updated_at || session.created_at || session.createdAt);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex w-full flex-col gap-2.5 rounded-2xl border border-border/60 bg-card/80 p-4 text-left shadow-sm transition-all hover:border-border hover:bg-card hover:shadow-md ${borderClass}`}
    >
      {/* Top row: status + provider + project + model */}
      <div className="flex items-center gap-2">
        <StatusDot status={statusEntry.status} />
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white ${
            provider === 'codex' ? 'bg-blue-600' : 'bg-violet-600'
          }`}
        >
          {provider}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {project.displayName || project.name}
        </span>
        {project.branch ? (
          <span className="ml-auto truncate text-[10px] text-muted-foreground/60">
            {project.branch}
          </span>
        ) : null}
      </div>

      {/* Title / summary */}
      <div className="min-h-[2.5rem]">
        <p className="line-clamp-1 text-sm font-medium text-foreground">
          {session.title || session.name || `Session ${session.id.slice(0, 8)}`}
        </p>
        {session.summary ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{session.summary}</p>
        ) : null}
      </div>

      {/* Bottom row: quick hints + time */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-[10px]">💬 Chat</span>
        <span className="text-[10px]">🖥 Terminal</span>
        <span className="ml-auto text-[10px]">{timeLabel}</span>
      </div>
    </button>
  );
}
