import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import type { Project } from '../../types/app';

interface ProjectListPanelProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onNewProject: () => void;
}

export default function ProjectListPanel({
  projects,
  selectedProject,
  onSelectProject,
  onNewProject,
}: ProjectListPanelProps) {
  const { t } = useTranslation('sidebar');

  return (
    <div className="flex h-full w-52 shrink-0 flex-col border-r border-border/50 bg-background/50">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <span className="text-xs font-semibold text-foreground">
          {t('projects', 'Projects')}
        </span>
        <button
          type="button"
          onClick={onNewProject}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          title="New project"
        >
          <span className="text-sm leading-none">+</span>
        </button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto space-y-0.5 px-2 py-2">
        {projects.map((project) => {
          const isSelected = selectedProject?.name === project.name;
          const sessionCount =
            (project.sessions?.length ?? 0) + (project.codexSessions?.length ?? 0);

          return (
            <button
              key={project.name}
              type="button"
              onClick={() => onSelectProject(project)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                isSelected
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{project.displayName || project.name}</span>
              {sessionCount > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground ml-auto">
                  {sessionCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
