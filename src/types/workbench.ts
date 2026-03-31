export type WorkbenchNav = 'projects' | 'extensions' | 'settings';

export type ProjectsView = 'overview' | 'project-overview' | 'workspace';

export type ExtensionsView = 'overview' | 'skills' | 'mcp';

export type WorkbenchState = {
  activeNav: WorkbenchNav;
  projectsView: ProjectsView;
  extensionsView: ExtensionsView;
};
