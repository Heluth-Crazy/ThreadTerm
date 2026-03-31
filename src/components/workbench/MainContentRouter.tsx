import MainContent from '../main-content/view/MainContent';
import type { MainContentProps } from '../main-content/types/types';
import type { ExtensionsView, ProjectsView, WorkbenchNav } from '../../types/workbench';
import type { Project, ProjectSession, SessionProvider } from '../../types/app';
import ExtensionsMcpPage from './extensions/ExtensionsMcpPage';
import ExtensionsOverviewPage from './extensions/ExtensionsOverviewPage';
import ExtensionsSkillsPage from './extensions/ExtensionsSkillsPage';
import ProjectsOverviewPage from './projects/ProjectsOverviewPage';
import SelectedProjectOverviewPage from './projects/SelectedProjectOverviewPage';
import SettingsPage from './settings/SettingsPage';

type MainContentRouterProps = {
  activeNav: WorkbenchNav;
  projectsView: ProjectsView;
  extensionsView: ExtensionsView;
  mainContentProps: MainContentProps;
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onSelectSession: (session: ProjectSession) => void;
  onDeleteSession: (projectName: string, sessionId: string, provider: SessionProvider) => void;
  onDeleteProjectState: (projectName: string) => void;
  onRefreshProjects: () => Promise<void>;
  onSelectProjectsOverview: () => void;
  onNewSession: (project: Project, provider?: string) => void;
  onCreateProject: () => void;
  onOpenSkills: () => void;
  onCreateSkill: () => void;
  onOpenMcp: () => void;
  onCreateMcp: (provider?: 'claude' | 'codex') => void;
  extensionsSkillCreateToken: number;
  onExtensionsSkillCreateHandled: () => void;
  extensionsMcpCreateRequest: {
    token: number;
    provider: 'claude' | 'codex';
  } | null;
  onExtensionsMcpCreateHandled: () => void;
  onShowSettings: () => void;
  settingsInitialTab: string;
};

export default function MainContentRouter({
  activeNav,
  projectsView,
  extensionsView,
  mainContentProps,
  projects,
  selectedProject,
  onSelectProject,
  onSelectSession,
  onDeleteSession,
  onDeleteProjectState,
  onRefreshProjects,
  onSelectProjectsOverview,
  onNewSession,
  onCreateProject,
  onOpenSkills,
  onCreateSkill,
  onOpenMcp,
  onCreateMcp,
  extensionsSkillCreateToken,
  onExtensionsSkillCreateHandled,
  extensionsMcpCreateRequest,
  onExtensionsMcpCreateHandled,
  onShowSettings,
  settingsInitialTab,
}: MainContentRouterProps) {
  if (activeNav === 'extensions') {
    if (extensionsView === 'overview') {
      return (
        <ExtensionsOverviewPage
          onOpenSkills={onOpenSkills}
          onCreateSkill={onCreateSkill}
          onOpenMcp={onOpenMcp}
          onCreateMcp={onCreateMcp}
        />
      );
    }

    if (extensionsView === 'mcp') {
      return <ExtensionsMcpPage createRequest={extensionsMcpCreateRequest} onCreateRequestHandled={onExtensionsMcpCreateHandled} />;
    }

    return <ExtensionsSkillsPage createRequestToken={extensionsSkillCreateToken} onCreateRequestHandled={onExtensionsSkillCreateHandled} />;
  }

  if (activeNav === 'settings') {
    return <SettingsPage initialTab={settingsInitialTab} />;
  }

  if (projectsView === 'overview') {
    return (
      <ProjectsOverviewPage
        projects={projects}
        onSelectProject={onSelectProject}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onCreateProject={onCreateProject}
        onShowSettings={onShowSettings}
      />
    );
  }

  if (projectsView === 'project-overview') {
    return (
      <SelectedProjectOverviewPage
        projects={projects}
        selectedProject={selectedProject}
        onSelectProject={onSelectProject}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onCreateProject={onCreateProject}
        onRefreshProjects={onRefreshProjects}
        onDeleteSession={onDeleteSession}
        onDeleteProjectState={onDeleteProjectState}
        onSelectOverview={onSelectProjectsOverview}
      />
    );
  }

  return <MainContent {...mainContentProps} />;
}
