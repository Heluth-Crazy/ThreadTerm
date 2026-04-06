import { useSessionStatusStore } from '../../stores/sessionStatusStore';
import type { Project, ProjectSession } from '../../types/app';

export interface BottomStatusStripProps {
  projects: Project[];
  selectedSession: ProjectSession | null;
  onSelectSession: (project: Project, session: ProjectSession) => void;
}

export default function BottomStatusStrip({
  projects,
  selectedSession,
  onSelectSession,
}: BottomStatusStripProps) {
  const statuses = useSessionStatusStore((s) => s.statuses);

  // Flatten all sessions
  const allSessions: { project: Project; session: ProjectSession }[] = [];
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      allSessions.push({ project, session: { ...session, __provider: session.__provider ?? 'claude' } });
    }
    for (const session of project.codexSessions ?? []) {
      allSessions.push({ project, session: { ...session, __provider: session.__provider ?? 'codex' } });
    }
  }

  if (allSessions.length === 0) return null;

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-t border-border/60 bg-card/80 px-3">
      {allSessions.map(({ project, session }) => {
        const isSelected = selectedSession?.id === session.id;
        const provider = session.__provider ?? 'claude';
        const status = statuses[session.id]?.status ?? 'idle';
        const title = session.title || session.name || session.id.slice(0, 8);

        return (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelectSession(project, session)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
              isSelected
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
          >
            {/* Status dot */}
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                status === 'needs_attention'
                  ? 'bg-red-500 animate-pulse'
                  : status === 'processing'
                    ? 'bg-blue-500'
                    : status === 'completed'
                      ? 'bg-emerald-500'
                      : 'bg-muted-foreground/40'
              }`}
            />
            <span className={`font-medium ${provider === 'codex' ? 'text-blue-600 dark:text-blue-400' : 'text-violet-600 dark:text-violet-400'}`}>
              {provider === 'codex' ? 'CX' : 'CL'}
            </span>
            <span className="max-w-[120px] truncate">{title}</span>
          </button>
        );
      })}
    </div>
  );
}
