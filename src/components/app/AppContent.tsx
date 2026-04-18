import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { Button } from '../ui/button';

import SecondarySidebarRouter from '../workbench/SecondarySidebarRouter';
import MainContentRouter from '../workbench/MainContentRouter';
import ProjectCreationWizard from '../ProjectCreationWizard';
import ChatPanel from '../chat/ChatPanel';
import MobileWorkbenchShell from '../mobile/MobileWorkbenchShell';
import type { MobilePrimaryTab } from '../mobile/MobileBottomTabs';
import MobileProjectsView from '../mobile/MobileProjectsView';
import MobileSessionsView from '../mobile/MobileSessionsView';

import LiveGridView from '../live-grid/view/LiveGridView';
import ErrorBoundary from '../shared/ErrorBoundary';
import CommandPalette from '../command-palette/CommandPalette';
import MissionControlView from '../overview/MissionControlView';
import SessionStatusCounts from '../overview/SessionStatusCounts';
import SessionFocusLayout from '../session-focus/SessionFocusLayout';
import BottomStatusStrip from '../status-strip/BottomStatusStrip';
import ProjectListPanel from '../projects/ProjectListPanel';
import ProjectSessionsPanel from '../projects/ProjectSessionsPanel';
import KeyboardShortcutsOverlay from '../overlays/KeyboardShortcutsOverlay';
import SessionTemplatesPicker from '../templates/SessionTemplatesPicker';
import ActivityBar from '../workbench/ActivityBar';
import SelectedProjectOverviewPage from '../workbench/projects/SelectedProjectOverviewPage';
import ToastContainer from '../shared/ToastContainer';

import { useWebSocket } from '../../contexts/TauriEventContext';
import { useMobileViewport } from '../../hooks/useMobileViewport';
import { useWorkbenchNavigation } from '../../hooks/useWorkbenchNavigation';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useGlobalKeyboardShortcuts } from '../../hooks/useGlobalKeyboardShortcuts';
import { useFileWatcher } from '../../hooks/useFileWatcher';
import type { Project, ProjectSession } from '../../types/app';
import type { SessionTemplate } from '../../types/templates';
import type { WorkbenchNav } from '../../types/workbench';

type DesktopViewMode = 'overview' | 'focus' | 'settings' | 'extensions' | 'livegrid' | 'queue';

export default function AppContent() {
  const { t } = useTranslation('common');
  const isMobileViewport = useMobileViewport();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { ws, sendMessage, latestMessage, messageSequence, getBufferedMessagesSince } = useWebSocket();
  const {
    activeNav,
    projectsView,
    extensionsView,
    setActiveNav,
    setProjectsView,
    setExtensionsView,
  } = useWorkbenchNavigation();

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  } = useSessionProtection();

  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    isLoadingProjects,
    externalMessageUpdate,
    settingsInitialTab,
    setActiveTab,
    openSettings,
    fetchProjects,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleProjectCreated,
    handleSessionDelete,
    handleSessionRename,
    handleProjectDelete,
    handleSidebarRefresh,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    activeSessions,
  });

  // Watch the active project directory for file changes
  const activeProjectPath = selectedProject?.fullPath ?? selectedProject?.path ?? null;
  const { lastChangeEvent, gitStatusTrigger } = useFileWatcher(activeProjectPath);

  // Dispatch custom DOM events so FileTree and GitPanel can listen
  useEffect(() => {
    if (lastChangeEvent) {
      window.dispatchEvent(new CustomEvent('openwork:file-changed', { detail: lastChangeEvent }));
    }
  }, [lastChangeEvent]);

  useEffect(() => {
    if (gitStatusTrigger > 0) {
      window.dispatchEvent(new CustomEvent('openwork:git-status-changed'));
    }
  }, [gitStatusTrigger]);

  const [extensionsSkillCreateToken, setExtensionsSkillCreateToken] = useState(0);
  const [extensionsMcpCreateToken, setExtensionsMcpCreateToken] = useState(0);
  const [extensionsMcpCreateProvider, setExtensionsMcpCreateProvider] = useState<'claude' | 'codex'>('claude');
  const [showProjectCreationWizard, setShowProjectCreationWizard] = useState(false);
  const [mobilePrimaryTab, setMobilePrimaryTab] = useState<MobilePrimaryTab>('projects');

  // --- New Polaris state ---
  const [viewMode, setViewMode] = useState<DesktopViewMode>('overview');

  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [showProjectDetail, setShowProjectDetail] = useState(false);

  // ⌘K keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Auto-switch to focus mode when session is selected
  useEffect(() => {
    if (selectedSession) {
      setViewMode('focus');
    }
  }, [selectedSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.refreshProjects = fetchProjects;

    return () => {
      if (window.refreshProjects === fetchProjects) {
        delete window.refreshProjects;
      }
    };
  }, [fetchProjects]);

  const routeToSettings = useCallback(
    (tab = 'agents') => {
      openSettings(tab);
      setActiveNav('settings');
      setViewMode('settings');
    },
    [openSettings, setActiveNav],
  );

  const routeToLiveGrid = useCallback(() => {
    setActiveNav('livegrid');
    setViewMode('livegrid');
  }, [setActiveNav]);

  useEffect(() => {
    window.openSettings = routeToSettings;

    return () => {
      if (window.openSettings === routeToSettings) {
        delete window.openSettings;
      }
    };
  }, [routeToSettings]);

  useEffect(() => {
    if (sessionId || selectedSession?.id) {
      setActiveNav('projects');
      setProjectsView('workspace');
    }
  }, [selectedSession?.id, sessionId, setActiveNav, setProjectsView]);

  useEffect(() => {
    if (!isMobileViewport) {
      return;
    }

    if (!selectedProject && mobilePrimaryTab !== 'projects') {
      setMobilePrimaryTab('projects');
    }
  }, [isMobileViewport, mobilePrimaryTab, selectedProject]);

  const handleOpenProjectCreation = useCallback(() => {
    setShowProjectCreationWizard(true);
  }, []);

  const handleCloseProjectCreation = useCallback(() => {
    setShowProjectCreationWizard(false);
  }, []);

  const handleProjectCreatedFromWorkbench = useCallback(
    async (project?: Project) => {
      await handleProjectCreated(project);
      setShowProjectCreationWizard(false);
      setActiveNav('projects');
      setProjectsView('project-overview');
    },
    [handleProjectCreated, setActiveNav, setProjectsView],
  );

  const openProjectsOverview = useCallback(() => {
    setActiveNav('projects');
    setProjectsView('overview');
  }, [setActiveNav, setProjectsView]);

  const openExtensionsOverview = useCallback(() => {
    setActiveNav('extensions');
    setExtensionsView('overview');
    setViewMode('extensions');
  }, [setActiveNav, setExtensionsView]);

  const openExtensionsSkills = useCallback(() => {
    setActiveNav('extensions');
    setExtensionsView('skills');
    setViewMode('extensions');
  }, [setActiveNav, setExtensionsView]);

  const openExtensionsMcp = useCallback(() => {
    setActiveNav('extensions');
    setExtensionsView('mcp');
    setViewMode('extensions');
  }, [setActiveNav, setExtensionsView]);

  const handleCreateSkillFromExtensions = useCallback(() => {
    openExtensionsSkills();
    setExtensionsSkillCreateToken((value) => value + 1);
  }, [openExtensionsSkills]);

  const handleCreateMcpFromExtensions = useCallback(
    (provider: 'claude' | 'codex' = 'claude') => {
      openExtensionsMcp();
      setExtensionsMcpCreateProvider(provider);
      setExtensionsMcpCreateToken((value) => value + 1);
    },
    [openExtensionsMcp],
  );

  const handleSelectProject = useCallback(
    (project: Project) => {
      setActiveNav('projects');
      setProjectsView('project-overview');
      handleProjectSelect(project);
      if (isMobileViewport) {
        setMobilePrimaryTab('sessions');
      }
    },
    [handleProjectSelect, isMobileViewport, setActiveNav, setProjectsView],
  );

  const handleSelectSession = useCallback(
    (session: ProjectSession) => {
      setActiveNav('projects');
      setProjectsView('workspace');
      setShowProjectDetail(false); // always dismiss project detail panel and show chat
      handleSessionSelect(session);
      if (isMobileViewport) {
        setActiveTab('chat');
        setMobilePrimaryTab('chat');
      }
    },
    [handleSessionSelect, isMobileViewport, setActiveNav, setActiveTab, setProjectsView],
  );

  const handleStartSession = useCallback(
    (project: Project, provider?: string) => {
      setActiveNav('projects');
      setProjectsView('workspace');
      handleNewSession(project, provider);
      if (isMobileViewport) {
        setMobilePrimaryTab('chat');
      }
    },
    [handleNewSession, isMobileViewport, setActiveNav, setProjectsView],
  );

  const handleStartSessionWithTemplatePicker = useCallback(
    (project: Project) => {
      handleSelectProject(project);
      setTemplatePickerOpen(true);
    },
    [handleSelectProject],
  );

  const handleTemplateSelect = useCallback(
    (template: SessionTemplate) => {
      setTemplatePickerOpen(false);
      if (!selectedProject) return;
      if (template.initialMessage) {
        window.__pendingTemplateMessage = template.initialMessage;
      }
      handleStartSession(selectedProject, template.provider);
    },
    [selectedProject, handleStartSession],
  );

  const handleTemplateSkip = useCallback(() => {
    setTemplatePickerOpen(false);
    if (!selectedProject) return;
    handleStartSession(selectedProject, undefined);
  }, [selectedProject, handleStartSession]);

  const handleSelectMobileTab = useCallback(
    (nextTab: MobilePrimaryTab) => {
      if ((nextTab === 'sessions' || nextTab === 'chat') && !selectedProject) {
        setMobilePrimaryTab('projects');
        return;
      }

      if (nextTab === 'chat') {
        setActiveTab('chat');
      }

      setMobilePrimaryTab(nextTab);
    },
    [selectedProject, setActiveTab],
  );

  // --- Polaris callbacks ---
  const handleSelectSessionWithFocus = useCallback(
    (project: Project, session: ProjectSession) => {
      handleSelectProject(project);
      handleSelectSession(session);
      setViewMode('focus');
    },
    [handleSelectProject, handleSelectSession],
  );

  const handleBackToOverview = useCallback(() => {
    setShowProjectDetail(true);
  }, []);

  // ActivityBar navigation handler
  const navActiveNav: WorkbenchNav =
    viewMode === 'livegrid' ? 'livegrid' :
    viewMode === 'settings' ? 'settings' :
    viewMode === 'extensions' ? 'extensions' :
    viewMode === 'queue' ? 'queue' :
    'projects';

  const handleNavSelect = useCallback((nav: WorkbenchNav) => {
    if (nav === 'livegrid') {
      routeToLiveGrid();
    } else if (nav === 'extensions') {
      openExtensionsSkills();
    } else if (nav === 'settings') {
      routeToSettings('agents');
    } else if (nav === 'queue') {
      setViewMode('queue');
      setActiveNav('queue');
    } else {
      setViewMode('overview');
      setActiveNav('projects');
    }
  }, [routeToLiveGrid, openExtensionsSkills, routeToSettings, setViewMode, setActiveNav]);

  // Reset fullscreen when leaving focus mode
  useEffect(() => {
    if (viewMode !== 'focus') {
      setIsFullscreen(false);
      setShowProjectDetail(false);
    }
  }, [viewMode]);

  // Session navigation helpers
  const allSessionsForProject = useMemo(() => {
    if (!selectedProject) return [];
    return [...(selectedProject.sessions || []), ...(selectedProject.codexSessions || [])];
  }, [selectedProject]);

  const handlePrevSession = useCallback(() => {
    if (!selectedSession || !selectedProject) return;
    const sessions = allSessionsForProject;
    const idx = sessions.findIndex((s) => s.id === selectedSession.id);
    if (idx > 0) handleSelectSessionWithFocus(selectedProject, sessions[idx - 1]);
  }, [selectedSession, selectedProject, allSessionsForProject, handleSelectSessionWithFocus]);

  const handleNextSession = useCallback(() => {
    if (!selectedSession || !selectedProject) return;
    const sessions = allSessionsForProject;
    const idx = sessions.findIndex((s) => s.id === selectedSession.id);
    if (idx < sessions.length - 1) handleSelectSessionWithFocus(selectedProject, sessions[idx + 1]);
  }, [selectedSession, selectedProject, allSessionsForProject, handleSelectSessionWithFocus]);

  // Global keyboard shortcuts (⌘K handled separately above)
  useGlobalKeyboardShortcuts({
    onToggleFullscreen: () => {
      if (viewMode === 'focus') setIsFullscreen((f) => !f);
    },
    onPrevSession: handlePrevSession,
    onNextSession: handleNextSession,
    onNewSession: handleOpenProjectCreation,
    onShowShortcuts: () => setShortcutsOpen(true),
    onNavigateSession: (index) => {
      const sessions = allSessionsForProject;
      if (sessions[index] && selectedProject) {
        handleSelectSessionWithFocus(selectedProject, sessions[index]);
      }
    },
    onOpenSettings: () => routeToSettings('agents'),
    onToggleSidebar: () => {
      if (viewMode === 'focus') setIsFullscreen((f) => !f);
    },
    onToggleShortcuts: () => setShortcutsOpen((prev) => !prev),
  });

  // --- Sidebar props (still used in focus mode) ---
  const workbenchSidebarProps = useMemo(
    () => ({
      ...sidebarSharedProps,
      onProjectSelect: handleSelectProject,
      onSessionSelect: handleSelectSession,
      onNewSession: handleStartSession,
      onShowSettings: () => routeToSettings('agents'),
    }),
    [handleSelectProject, handleSelectSession, handleStartSession, routeToSettings, sidebarSharedProps],
  );

  const secondarySidebar = (
    <SecondarySidebarRouter
      activeNav={activeNav}
      projectsView={projectsView}
      extensionsView={extensionsView}
      settingsTab={settingsInitialTab === 'appearance' || settingsInitialTab === 'git' || settingsInitialTab === 'shortcuts' ? settingsInitialTab : 'agents'}
      onSelectOverview={openProjectsOverview}
      onSelectExtensionsView={setExtensionsView}
      onSelectSettingsTab={routeToSettings}
      sidebarProps={workbenchSidebarProps}
    />
  );

  // --- Settings / Extensions full-page content (reuse MainContentRouter) ---
  const settingsExtensionsContent = (
    <MainContentRouter
      activeNav={activeNav}
      projectsView={projectsView}
      extensionsView={extensionsView}
      projects={projects}
      selectedProject={selectedProject}
      onSelectProject={handleSelectProject}
      onSelectSession={handleSelectSession}
      onDeleteSession={handleSessionDelete}
      onDeleteProjectState={handleProjectDelete}
      onRefreshProjects={handleSidebarRefresh}
      onSelectProjectsOverview={openProjectsOverview}
      onNewSession={handleStartSession}
      onCreateProject={handleOpenProjectCreation}
      onOpenSkills={openExtensionsSkills}
      onCreateSkill={handleCreateSkillFromExtensions}
      onOpenMcp={openExtensionsMcp}
      onCreateMcp={handleCreateMcpFromExtensions}
      extensionsSkillCreateToken={extensionsSkillCreateToken}
      onExtensionsSkillCreateHandled={() => setExtensionsSkillCreateToken(0)}
      extensionsMcpCreateRequest={
        extensionsMcpCreateToken > 0
          ? {
              token: extensionsMcpCreateToken,
              provider: extensionsMcpCreateProvider,
            }
          : null
      }
      onExtensionsMcpCreateHandled={() => setExtensionsMcpCreateToken(0)}
      settingsInitialTab={settingsInitialTab}
      onShowSettings={() => routeToSettings('agents')}
      mainContentProps={{
        selectedProject,
        selectedSession,
        activeTab,
        setActiveTab,
        projects,
        ws,
        sendMessage,
        latestMessage,
        messageSequence,
        getBufferedMessagesSince,
        isLoading: isLoadingProjects,
        onSessionActive: markSessionAsActive,
        onSessionInactive: markSessionAsInactive,
        onSessionProcessing: markSessionAsProcessing,
        onSessionNotProcessing: markSessionAsNotProcessing,
        processingSessions,
        onReplaceTemporarySession: replaceTemporarySession,
        onNavigateToSession: (targetSessionId: string) => navigate(`/session/${targetSessionId}`),
        onShowSettings: () => routeToSettings('agents'),
        externalMessageUpdate,
      }}
    />
  );

  // --- Mobile content (UNCHANGED) ---
  const mobileMainContent = useMemo(() => {
    if (mobilePrimaryTab === 'projects') {
      return (
        <MobileProjectsView
          projects={projects}
          selectedProject={selectedProject}
          isLoading={isLoadingProjects}
          onSelectProject={handleSelectProject}
          onCreateProject={handleOpenProjectCreation}
        />
      );
    }

    if (mobilePrimaryTab === 'sessions') {
      return (
        <MobileSessionsView
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          onSelectProjectTab={() => setMobilePrimaryTab('projects')}
          onSelectSession={handleSelectSession}
          onNewSession={handleStartSession}
        />
      );
    }

    if (!selectedProject) {
      return (
        <section className="flex h-full items-center justify-center px-6">
          <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card/80 p-5 text-center">
            <h2 className="text-sm font-semibold text-foreground">No project selected</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Choose a project first, then continue chat from your phone.
            </p>
            <button
              type="button"
              onClick={() => setMobilePrimaryTab('projects')}
              className="mt-4 inline-flex h-9 items-center rounded-lg border border-border/60 bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              Open Projects
            </button>
          </div>
        </section>
      );
    }

    return (
      <ChatPanel
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        sendMessage={sendMessage}
        latestMessage={latestMessage}
        messageSequence={messageSequence}
        getBufferedMessagesSince={getBufferedMessagesSince}
        externalMessageUpdate={externalMessageUpdate}
        onSessionActive={markSessionAsActive}
        onSessionInactive={markSessionAsInactive}
        onSessionProcessing={markSessionAsProcessing}
        onSessionNotProcessing={markSessionAsNotProcessing}
        onReplaceTemporarySession={replaceTemporarySession}
        onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
      />
    );
  }, [
    externalMessageUpdate,
    getBufferedMessagesSince,
    handleOpenProjectCreation,
    handleSelectProject,
    handleSelectSession,
    handleStartSession,
    isLoadingProjects,
    latestMessage,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsNotProcessing,
    markSessionAsProcessing,
    messageSequence,
    mobilePrimaryTab,
    navigate,
    projects,
    replaceTemporarySession,
    selectedProject,
    selectedSession,
    sendMessage,
  ]);

  // --- Desktop content: new Polaris layout ---
  const desktopContent = (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Thin top bar */}
      <header className="flex h-11 shrink-0 items-center border-b border-border/60 bg-card/80">
        <div className="flex w-14 shrink-0 items-center justify-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-foreground text-xs font-bold text-background">
            O
          </div>
        </div>

        <div className="flex items-center gap-3 px-2">
        {viewMode === 'focus' || viewMode === 'settings' || viewMode === 'extensions' || viewMode === 'livegrid' || viewMode === 'queue' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBackToOverview}
            className="gap-1 text-muted-foreground hover:text-foreground px-2 h-7"
          >
            <ChevronLeft className="w-4 h-4" />
            {t('overview.backToOverview', 'Overview')}
          </Button>
        ) : (
          <span className="text-sm font-medium text-foreground">OpenWork</span>
        )}
        </div>

        <div className="flex-1" />

        {/* Status counts */}
        <SessionStatusCounts />

        {/* ⌘K trigger */}
        <button
          type="button"
          onClick={() => setCmdPaletteOpen(true)}
          className="flex items-center gap-1 rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50"
        >
          <span>⌘K</span>
        </button>

        {/* Settings shortcut */}
        <button
          type="button"
          onClick={() => routeToSettings('agents')}
          className="rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          title="Settings"
        >
          ⚙
        </button>
      </header>

      {/* Main content area */}
      <div className="flex min-h-0 flex-1">
        {/* Activity Bar */}
        <ActivityBar activeNav={navActiveNav} onSelectNav={handleNavSelect} />

        {/* Content area */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {viewMode === 'overview' ? (
          <MissionControlView
            projects={projects}
            isLoading={isLoadingProjects}
            onSelectSession={handleSelectSessionWithFocus}
            onNewSession={handleOpenProjectCreation}
            onCreateProject={handleOpenProjectCreation}
          />
        ) : viewMode === 'livegrid' ? (
          <ErrorBoundary area="Live Grid">
            <LiveGridView
              projects={projects}
              onNewSession={handleOpenProjectCreation}
            />
          </ErrorBoundary>
        ) : viewMode === 'settings' || viewMode === 'extensions' ? (
          <div className="flex min-h-0 flex-1">
            <div className="w-64 shrink-0 overflow-hidden border-r border-border/50">
              {secondarySidebar}
            </div>
            <div className="min-w-0 flex-1">{settingsExtensionsContent}</div>
          </div>
        ) : viewMode === 'queue' ? (
          <div className="min-w-0 flex-1">{settingsExtensionsContent}</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1">
              {/* Panel 1: Project list (hidden in fullscreen) */}
              {!isFullscreen && (
                <ProjectListPanel
                  projects={projects}
                  selectedProject={selectedProject}
                  onSelectProject={(project) => {
                    handleSelectProject(project);
                  }}
                  onNewProject={handleOpenProjectCreation}
                />
              )}

              {/* Panel 2: Session cards for selected project (hidden in fullscreen) */}
              {!isFullscreen && selectedProject && (
                <ProjectSessionsPanel
                  project={selectedProject}
                  selectedSession={selectedSession}
                  onSelectSession={handleSelectSessionWithFocus}
                  onNewSession={() => handleStartSessionWithTemplatePicker(selectedProject)}
                  onDeleteSession={handleSessionDelete}
                  onRenameSession={handleSessionRename}
                  onViewProjectDetail={() => setShowProjectDetail(true)}
                />
              )}

              {/* Panel 3: Session focus or Project detail */}
              {selectedProject ? (
                showProjectDetail ? (
                  <div className="min-w-0 flex-1 overflow-y-auto">
                    <SelectedProjectOverviewPage
                      projects={projects}
                      selectedProject={selectedProject}
                      onSelectProject={handleSelectProject}
                      onSelectSession={(session) => {
                        setShowProjectDetail(false);
                        handleSelectSession(session);
                      }}
                      onNewSession={handleStartSession}
                      onCreateProject={handleOpenProjectCreation}
                      onRefreshProjects={handleSidebarRefresh}
                      onDeleteSession={handleSessionDelete}
                      onDeleteProjectState={handleProjectDelete}
                      onSelectOverview={() => setShowProjectDetail(false)}
                    />
                  </div>
                ) : (
                  <div className="min-w-0 flex-1 flex flex-col overflow-hidden">
                    <SessionFocusLayout
                    projects={projects}
                    selectedProject={selectedProject}
                    selectedSession={selectedSession}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    sendMessage={sendMessage}
                    latestMessage={latestMessage}
                    messageSequence={messageSequence}
                    getBufferedMessagesSince={getBufferedMessagesSince}
                    externalMessageUpdate={externalMessageUpdate}
                    onSessionActive={markSessionAsActive}
                    onSessionInactive={markSessionAsInactive}
                    onSessionProcessing={markSessionAsProcessing}
                    onSessionNotProcessing={markSessionAsNotProcessing}
                    processingSessions={processingSessions}
                    onReplaceTemporarySession={replaceTemporarySession}
                    onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
                    onBackToOverview={handleBackToOverview}
                    onShowSettings={() => routeToSettings('agents')}
                    onRenameSession={handleSessionRename}
                    ws={ws}
                    isLoading={isLoadingProjects}
                  />
                  </div>
                )
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Select a project and session to begin
                </div>
              )}
            </div>
            {/* Bottom status strip */}
            <BottomStatusStrip
              projects={projects}
              selectedSession={selectedSession}
              onSelectSession={handleSelectSessionWithFocus}
            />
          </div>
        )}
        </div>
      </div>

      {/* Command palette overlay */}
      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        projects={projects}
        selectedSession={selectedSession}
        onSelectSession={(project, session) => {
          setCmdPaletteOpen(false);
          handleSelectSessionWithFocus(project, session);
        }}
        onNewSession={() => {
          setCmdPaletteOpen(false);
          handleOpenProjectCreation();
        }}
        onOpenSettings={() => {
          setCmdPaletteOpen(false);
          routeToSettings('agents');
        }}
        onOpenExtensions={() => {
          setCmdPaletteOpen(false);
          openExtensionsOverview();
        }}
      />

      {/* Keyboard shortcuts overlay */}
      <KeyboardShortcutsOverlay
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {/* Session template picker */}
      <SessionTemplatesPicker
        open={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        onSelectTemplate={handleTemplateSelect}
        onSkip={handleTemplateSkip}
      />
    </div>
  );

  return (
    <>
      {isMobileViewport ? (
        <MobileWorkbenchShell activeTab={mobilePrimaryTab} onSelectTab={handleSelectMobileTab}>
          {mobileMainContent}
        </MobileWorkbenchShell>
      ) : (
        desktopContent
      )}
      {showProjectCreationWizard ? (
        <ProjectCreationWizard
          onClose={handleCloseProjectCreation}
          onProjectCreated={handleProjectCreatedFromWorkbench}
        />
      ) : null}
      <ToastContainer />
    </>
  );
}
