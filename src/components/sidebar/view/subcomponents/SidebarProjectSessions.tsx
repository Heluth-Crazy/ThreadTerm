import { useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { ChevronDown, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../ui/button';
import type {
  Project,
  ProjectSession,
  SessionLaunchOptions,
  SessionLaunchProfile,
  SessionLaunchProvider,
  SessionProvider,
} from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import {
  loadSessionLaunchProfilesByProvider,
  mergeSessionLaunchArgs,
  parseSessionLaunchArgsInput,
} from '../../../../utils/sessionLaunchProfiles';
import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
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
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project, provider?: string, launchOptions?: SessionLaunchOptions) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function NewSessionPicker({
  project,
  onProjectSelect,
  onNewSession,
  t,
}: {
  project: Project;
  onProjectSelect: (project: Project) => void;
  onNewSession: (project: Project, provider?: string, launchOptions?: SessionLaunchOptions) => void;
  t: TFunction;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [showLaunchDialog, setShowLaunchDialog] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<SessionLaunchProvider>('claude');
  const [profiles, setProfiles] = useState<SessionLaunchProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [extraArgsInput, setExtraArgsInput] = useState('');

  const startConfiguringProvider = (provider: SessionLaunchProvider) => {
    const launchProfiles = loadSessionLaunchProfilesByProvider(provider);
    setSelectedProvider(provider);
    setProfiles(launchProfiles.profiles);
    setSelectedProfileId(launchProfiles.defaultProfileId);
    setExtraArgsInput('');
    setShowLaunchDialog(true);
  };

  const closeLaunchDialog = () => {
    setShowLaunchDialog(false);
    setExtraArgsInput('');
  };

  const handleStartNewSession = () => {
    const temporaryArgs = parseSessionLaunchArgsInput(extraArgsInput);
    const launchOptions: SessionLaunchOptions = {
      profileId: selectedProfileId,
      args: temporaryArgs,
    };

    onProjectSelect(project);
    onNewSession(project, selectedProvider, launchOptions);
    closeLaunchDialog();
    setShowPicker(false);
  };

  const mergedArgsPreview = useMemo(
    () =>
      mergeSessionLaunchArgs(
        profiles,
        selectedProfileId,
        parseSessionLaunchArgsInput(extraArgsInput),
      ),
    [extraArgsInput, profiles, selectedProfileId],
  );

  const previewCommand = useMemo(() => {
    const baseCommand = selectedProvider === 'codex' ? 'codex' : 'claude';
    const argsText = mergedArgsPreview.join(' ');
    return argsText ? `${baseCommand} ${argsText}` : baseCommand;
  }, [mergedArgsPreview, selectedProvider]);

  const launchDialog = showLaunchDialog
    ? ReactDOM.createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl">
            <div className="border-b border-border px-5 py-4">
              <h3 className="text-base font-semibold text-foreground">
                {t('messages.configureSessionLaunch', 'Configure Session Launch')}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedProvider === 'codex' ? 'Codex' : 'Claude'} {t('messages.sessionLaunchArgs', 'startup arguments')}
              </p>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  {t('messages.profileGroup', 'Profile Group')}
                </label>
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  value={selectedProfileId}
                  onChange={(event) => setSelectedProfileId(event.target.value)}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  {t('messages.temporaryArgs', 'Temporary Args (one per line)')}
                </label>
                <textarea
                  value={extraArgsInput}
                  onChange={(event) => setExtraArgsInput(event.target.value)}
                  placeholder="--dangerously-skip-permissions"
                  rows={4}
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div className="space-y-1.5 rounded-md border border-border/70 bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">
                  {t('messages.finalCommandPreview', 'Final Command Preview')}
                </div>
                <code className="break-all text-xs text-foreground">{previewCommand}</code>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="outline" size="sm" onClick={closeLaunchDialog}>
                {t('actions.cancel')}
              </Button>
              <Button size="sm" onClick={handleStartNewSession}>
                {t('sessions.newSession')}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  if (showPicker) {
    return (
      <>
        <div className="mt-1 space-y-1">
          <p className="mb-1 px-1 text-xs text-muted-foreground">
            {t('messages.selectProviderForSession', 'Select provider for this session')}
          </p>
          <button
            className="flex h-7 w-full items-center justify-center gap-2 rounded-md bg-blue-600 text-xs font-medium text-white transition-colors hover:bg-blue-700"
            onClick={() => startConfiguringProvider('claude')}
          >
            Claude Code
          </button>
          <button
            className="flex h-7 w-full items-center justify-center gap-2 rounded-md bg-green-600 text-xs font-medium text-white transition-colors hover:bg-green-700"
            onClick={() => startConfiguringProvider('codex')}
          >
            Codex
          </button>
          <button
            className="flex h-7 w-full items-center justify-center gap-2 rounded-md bg-muted text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80"
            onClick={() => setShowPicker(false)}
          >
            {t('actions.cancel')}
          </button>
        </div>
        {launchDialog}
      </>
    );
  }

  return (
    <>
      <Button
        variant="default"
        size="sm"
        className="mt-1 h-7 w-full justify-start gap-1.5 rounded-lg bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        onClick={() => setShowPicker(true)}
      >
        <Plus className="h-3 w-3" />
        {t('sessions.newSession')}
      </Button>
      {launchDialog}
    </>
  );
}

export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  isLoadingSessions,
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
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const hasMoreSessions = project.sessionMeta?.hasMore === true;

  return (
    <div className="ml-2.5 space-y-0.5 border-l border-border/70 pl-2.5">
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !isLoadingSessions ? (
        <div className="px-2 py-1.5 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        sessions.map((session) => (
          <SidebarSessionItem
            key={session.id}
            project={project}
            session={session}
            selectedSession={selectedSession}
            currentTime={currentTime}
            editingSession={editingSession}
            editingSessionName={editingSessionName}
            onEditingSessionNameChange={onEditingSessionNameChange}
            onStartEditingSession={onStartEditingSession}
            onCancelEditingSession={onCancelEditingSession}
            onSaveEditingSession={onSaveEditingSession}
            onProjectSelect={onProjectSelect}
            onSessionSelect={onSessionSelect}
            onDeleteSession={onDeleteSession}
            t={t}
          />
        ))
      )}

      {hasSessions && hasMoreSessions && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1.5 w-full justify-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/45"
          onClick={() => onLoadMoreSessions(project)}
          disabled={isLoadingSessions}
        >
          {isLoadingSessions ? (
            <>
              <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
              {t('sessions.loading')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              {t('sessions.showMore')}
            </>
          )}
        </Button>
      )}

      <NewSessionPicker
        project={project}
        onProjectSelect={onProjectSelect}
        onNewSession={onNewSession}
        t={t}
      />
    </div>
  );
}
