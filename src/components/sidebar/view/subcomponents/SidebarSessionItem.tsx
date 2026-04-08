import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Check, Clock, Edit2, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import { formatTimeAgo } from '../../../../utils/dateUtils';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel } from '../../utils/utils';
import SessionProviderLogo from '../../../SessionProviderLogo';
import { SessionStatusBadge } from '../../../shared/SessionStatusBadge';
import { useState } from 'react';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  t: TFunction;
  draggable?: boolean;
};

export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  t,
  draggable = true,
}: SidebarSessionItemProps) {
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const [isDragging, setIsDragging] = useState(false);

  const saveEditedSession = () => {
    onSaveEditingSession(project.name, session.id, editingSessionName);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.name, session.id, sessionView.sessionName, session.__provider);
  };

  const handleDragStart = (event: React.DragEvent) => {
    setIsDragging(true);
    const dragData = {
      sessionId: session.id,
      sessionName: sessionView.sessionName,
      provider: session.__provider,
      projectName: project.name,
      projectPath: project.fullPath || project.path,
    };
    const serialized = JSON.stringify(dragData);
    event.dataTransfer.setData('application/json', serialized);
    event.dataTransfer.setData('text/x-openwork-session', serialized);
    event.dataTransfer.setData('text/plain', sessionView.sessionName);
    event.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  return (
    <div className={cn('group relative', isDragging && 'cursor-grabbing opacity-50')}>
      {sessionView.isActive && (
        <div className="absolute left-0 top-1/2 -translate-x-0.5 -translate-y-1/2 transform">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
        </div>
      )}

      <Button
        variant="ghost"
        className={cn(
          'h-auto w-full justify-start rounded-lg px-2 py-1.5 text-left font-normal transition-all duration-150 hover:bg-muted/55',
          isSelected && 'bg-muted text-accent-foreground',
          draggable && 'cursor-grab',
          isDragging && 'cursor-grabbing opacity-50',
        )}
        onClick={() => {
          onProjectSelect(project);
          onSessionSelect(session, project.name);
        }}
        draggable={draggable}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex min-w-0 w-full items-start gap-1.5">
          <SessionProviderLogo provider={session.__provider} className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="truncate text-[11px] font-medium text-foreground">{sessionView.sessionName}</span>
              <SessionStatusBadge sessionId={session.id} compact />
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px]">
              <Clock className="h-2.5 w-2.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {formatTimeAgo(sessionView.sessionTime, currentTime, t)}
              </span>
              {sessionView.messageCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-auto px-1 py-0 text-xs transition-opacity group-hover:opacity-0"
                >
                  {sessionView.messageCount}
                </Badge>
              )}
              <span className="ml-1 opacity-70 transition-opacity group-hover:opacity-0">
                <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
              </span>
            </div>
          </div>
        </div>
      </Button>

      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 transform items-center gap-0.5 opacity-0 transition-all duration-150 group-hover:opacity-100">
        {editingSession === session.id && !sessionView.isCodexSession ? (
          <>
            <input
              type="text"
              value={editingSessionName}
              onChange={(event) => onEditingSessionNameChange(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  saveEditedSession();
                } else if (event.key === 'Escape') {
                  onCancelEditingSession();
                }
              }}
              onClick={(event) => event.stopPropagation()}
              className="w-32 rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <button
              className="flex h-5 w-5 items-center justify-center rounded-md bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
              onClick={(event) => {
                event.stopPropagation();
                saveEditedSession();
              }}
              title={t('tooltips.save')}
            >
              <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
            </button>
            <button
              className="flex h-5 w-5 items-center justify-center rounded-md bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
              onClick={(event) => {
                event.stopPropagation();
                onCancelEditingSession();
              }}
              title={t('tooltips.cancel')}
            >
              <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
            </button>
          </>
        ) : (
          <>
            {!sessionView.isCodexSession && (
              <button
                className="flex h-5 w-5 items-center justify-center rounded-md bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  onStartEditingSession(session.id, session.summary || t('projects.newSession'));
                }}
                title={t('tooltips.editSessionName')}
              >
                <Edit2 className="h-3 w-3 text-gray-600 dark:text-gray-400" />
              </button>
            )}
            <button
              className="flex h-5 w-5 items-center justify-center rounded-md bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40"
              onClick={(event) => {
                event.stopPropagation();
                requestDeleteSession();
              }}
              title={t('tooltips.deleteSession')}
            >
              <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
