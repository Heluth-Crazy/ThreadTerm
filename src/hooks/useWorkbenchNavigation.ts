import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExtensionsView, ProjectsView, WorkbenchNav, WorkbenchState } from '../types/workbench';

const STORAGE_KEY = 'openwork.workbench';

const DEFAULT_STATE: WorkbenchState = {
  activeNav: 'projects',
  projectsView: 'overview',
  extensionsView: 'overview',
};

function isWorkbenchNav(value: unknown): value is WorkbenchNav {
  return value === 'projects' || value === 'extensions' || value === 'settings' || value === 'livegrid';
}

function isProjectsView(value: unknown): value is ProjectsView {
  return value === 'overview' || value === 'project-overview' || value === 'workspace';
}

function isExtensionsView(value: unknown): value is ExtensionsView {
  return value === 'overview' || value === 'skills' || value === 'mcp';
}

function readInitialState(): WorkbenchState {
  if (typeof window === 'undefined') {
    return DEFAULT_STATE;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_STATE;
    }

    const parsed = JSON.parse(raw) as Partial<WorkbenchState>;

    return {
      activeNav: isWorkbenchNav(parsed.activeNav) ? parsed.activeNav : DEFAULT_STATE.activeNav,
      projectsView: isProjectsView(parsed.projectsView) ? parsed.projectsView : DEFAULT_STATE.projectsView,
      extensionsView: isExtensionsView(parsed.extensionsView)
        ? parsed.extensionsView
        : DEFAULT_STATE.extensionsView,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export function useWorkbenchNavigation() {
  const [state, setState] = useState<WorkbenchState>(readInitialState);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const setActiveNav = useCallback((activeNav: WorkbenchNav) => {
    setState((current) => ({ ...current, activeNav }));
  }, []);

  const setProjectsView = useCallback((projectsView: ProjectsView) => {
    setState((current) => ({ ...current, projectsView }));
  }, []);

  const setExtensionsView = useCallback((extensionsView: ExtensionsView) => {
    setState((current) => ({ ...current, extensionsView }));
  }, []);

  return useMemo(
    () => ({
      ...state,
      setActiveNav,
      setProjectsView,
      setExtensionsView,
    }),
    [setActiveNav, setExtensionsView, setProjectsView, state],
  );
}
