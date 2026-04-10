import type { SidebarProps } from '../sidebar/types/types';
import type { ExtensionsView, ProjectsView, WorkbenchNav } from '../../types/workbench';
import ExtensionsSidebarPanel from './extensions/ExtensionsSidebarPanel';
import ProjectsSidebarPanel from './projects/ProjectsSidebarPanel';
import SettingsSidebarPanel from './settings/SettingsSidebarPanel';

type SecondarySidebarRouterProps = {
  activeNav: WorkbenchNav;
  projectsView: ProjectsView;
  extensionsView: ExtensionsView;
  settingsTab: 'agents' | 'appearance' | 'git' | 'shortcuts';
  onSelectOverview: () => void;
  onSelectExtensionsView: (view: ExtensionsView) => void;
  onSelectSettingsTab: (tab: 'agents' | 'appearance' | 'git' | 'shortcuts') => void;
  sidebarProps: SidebarProps;
};

export default function SecondarySidebarRouter({
  activeNav,
  projectsView,
  extensionsView,
  settingsTab,
  onSelectOverview,
  onSelectExtensionsView,
  onSelectSettingsTab,
  sidebarProps,
}: SecondarySidebarRouterProps) {
  if (activeNav === 'extensions') {
    return (
      <ExtensionsSidebarPanel activeView={extensionsView} onSelectView={onSelectExtensionsView} />
    );
  }

  if (activeNav === 'settings') {
    return <SettingsSidebarPanel activeTab={settingsTab} onSelectTab={onSelectSettingsTab} />;
  }

  return (
    <ProjectsSidebarPanel
      sidebarProps={sidebarProps}
      isOverviewActive={projectsView === 'overview'}
      onSelectOverview={onSelectOverview}
    />
  );
}
