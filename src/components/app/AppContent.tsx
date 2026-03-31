import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import ActivityBar from '../workbench/ActivityBar';
import AppShell from '../workbench/AppShell';
import MainContentRouter from '../workbench/MainContentRouter';
import SecondarySidebarRouter from '../workbench/SecondarySidebarRouter';
import ProjectCreationWizard from '../ProjectCreationWizard';
import ChatPanel from '../chat/ChatPanel';
import MobileWorkbenchShell from '../mobile/MobileWorkbenchShell';
import type { MobilePrimaryTab } from '../mobile/MobileBottomTabs';
import MobileProjectsView from '../mobile/MobileProjectsView';
import MobileSessionsView from '../mobile/MobileSessionsView';

import { useWebSocket } from '../../contexts/WebSocketContext';
import { useMobileViewport } from '../../hooks/useMobileViewport';
import { useWorkbenchNavigation } from '../../hooks/useWorkbenchNavigation';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import type { Project, ProjectSession } from '../../types/app';

export default function AppContent() {
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
    handleProjectDelete,
    handleSidebarRefresh,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    activeSessions,
  });

  const [extensionsSkillCreateToken, setExtensionsSkillCreateToken] = useState(0);
  const [extensionsMcpCreateToken, setExtensionsMcpCreateToken] = useState(0);
  const [extensionsMcpCreateProvider, setExtensionsMcpCreateProvider] = useState<'claude' | 'codex'>('claude');
  const [showProjectCreationWizard, setShowProjectCreationWizard] = useState(false);
  const [mobilePrimaryTab, setMobilePrimaryTab] = useState<MobilePrimaryTab>('projects');

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
    },
    [openSettings, setActiveNav],
  );

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
  }, [setActiveNav, setExtensionsView]);

  const openExtensionsSkills = useCallback(() => {
    setActiveNav('extensions');
    setExtensionsView('skills');
  }, [setActiveNav, setExtensionsView]);

  const openExtensionsMcp = useCallback(() => {
    setActiveNav('extensions');
    setExtensionsView('mcp');
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

  const handleSelectNav = (nav: 'projects' | 'extensions' | 'settings') => {
    if (nav === 'projects') {
      openProjectsOverview();
      return;
    }

    if (nav === 'extensions') {
      openExtensionsOverview();
      return;
    }

    setActiveNav('settings');
  };

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

  const activityBar = <ActivityBar activeNav={activeNav} onSelectNav={handleSelectNav} />;

  const secondarySidebar = (
    <SecondarySidebarRouter
      activeNav={activeNav}
      projectsView={projectsView}
      extensionsView={extensionsView}
      settingsTab={settingsInitialTab === 'appearance' || settingsInitialTab === 'git' ? settingsInitialTab : 'agents'}
      onSelectOverview={openProjectsOverview}
      onSelectExtensionsView={setExtensionsView}
      onSelectSettingsTab={routeToSettings}
      sidebarProps={workbenchSidebarProps}
    />
  );

  const mainContent = (
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

  return (
    <>
      {isMobileViewport ? (
        <MobileWorkbenchShell activeTab={mobilePrimaryTab} onSelectTab={handleSelectMobileTab}>
          {mobileMainContent}
        </MobileWorkbenchShell>
      ) : (
        <AppShell
          activityBar={activityBar}
          secondarySidebar={secondarySidebar}
          mainContent={mainContent}
          hideSecondarySidebar={activeNav === 'projects' && activeTab === 'hybrid'}
        />
      )}
      {showProjectCreationWizard ? (
        <ProjectCreationWizard
          onClose={handleCloseProjectCreation}
          onProjectCreated={handleProjectCreatedFromWorkbench}
        />
      ) : null}
    </>
  );
}
