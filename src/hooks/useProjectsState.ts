import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { api } from '../utils/api';
import type {
  AppSocketMessage,
  AppTab,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
  SessionLaunchOptions,
  SessionProvider,
} from '../types/app';
import { loadSessionLaunchProfilesByProvider, mergeSessionLaunchArgs } from '../utils/sessionLaunchProfiles';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  activeSessions: Set<string>;
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);
const SESSION_LAUNCH_META_STORAGE_KEY = 'openwork-session-launch-meta-v1';

type StoredSessionLaunchMeta = {
  args: string[];
  profileId: string | null;
  provider: SessionProvider;
  projectName?: string;
  updatedAt: number;
};

type StoredSessionLaunchMetaMap = Record<string, StoredSessionLaunchMeta>;

const normalizeLaunchArgs = (rawArgs: unknown): string[] => {
  if (!Array.isArray(rawArgs)) {
    return [];
  }

  return rawArgs
    .map((arg) => (typeof arg === 'string' ? arg.trim() : ''))
    .filter((arg) => arg.length > 0);
};

const readStoredLaunchMeta = (): StoredSessionLaunchMetaMap => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(SESSION_LAUNCH_META_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const result: StoredSessionLaunchMetaMap = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }

      const entry = value as Record<string, unknown>;
      const provider = entry.provider === 'codex'
        ? 'codex'
        : entry.provider === 'claude'
          ? 'claude'
          : null;
      if (!provider) {
        continue;
      }

      result[sessionId] = {
        args: normalizeLaunchArgs(entry.args),
        profileId: typeof entry.profileId === 'string' && entry.profileId.trim().length > 0
          ? entry.profileId
          : null,
        provider,
        projectName: typeof entry.projectName === 'string' ? entry.projectName : undefined,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
      };
    }

    return result;
  } catch {
    return {};
  }
};

const writeStoredLaunchMeta = (value: StoredSessionLaunchMetaMap) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(SESSION_LAUNCH_META_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage write failures.
  }
};

const getFallbackLaunchMeta = (provider?: SessionProvider) => {
  if (provider !== 'claude' && provider !== 'codex') {
    return null;
  }

  const providerProfiles = loadSessionLaunchProfilesByProvider(provider);
  const profileId = providerProfiles.defaultProfileId || null;
  const args = profileId
    ? mergeSessionLaunchArgs(providerProfiles.profiles, profileId, [])
    : [];

  if (!profileId && args.length === 0) {
    return null;
  }

  return { profileId, args };
};

const applyStoredLaunchMetaToSession = (
  session: ProjectSession,
  provider?: SessionProvider,
  projectName?: string,
  storedMap?: StoredSessionLaunchMetaMap,
): ProjectSession => {
  const resolvedProvider = provider || session.__provider;
  const explicitArgs = normalizeLaunchArgs(session.__launchArgs);
  const explicitProfileId = typeof session.__launchProfileId === 'string' && session.__launchProfileId.trim().length > 0
    ? session.__launchProfileId
    : null;

  if (explicitArgs.length > 0) {
    return {
      ...session,
      ...(resolvedProvider ? { __provider: resolvedProvider } : {}),
      ...(explicitProfileId ? { __launchProfileId: explicitProfileId } : {}),
      __launchArgs: explicitArgs,
    };
  }

  if (explicitProfileId && (resolvedProvider === 'claude' || resolvedProvider === 'codex')) {
    const providerProfiles = loadSessionLaunchProfilesByProvider(resolvedProvider);
    const mergedArgs = mergeSessionLaunchArgs(providerProfiles.profiles, explicitProfileId, []);
    return {
      ...session,
      __provider: resolvedProvider,
      __launchProfileId: explicitProfileId,
      ...(mergedArgs.length > 0 ? { __launchArgs: mergedArgs } : {}),
    };
  }

  const stored = (storedMap || readStoredLaunchMeta())[session.id];
  if (
    stored &&
    (!resolvedProvider || stored.provider === resolvedProvider) &&
    (!projectName || !stored.projectName || stored.projectName === projectName)
  ) {
    return {
      ...session,
      __provider: resolvedProvider || stored.provider,
      ...(stored.profileId ? { __launchProfileId: stored.profileId } : {}),
      ...(stored.args.length > 0 ? { __launchArgs: stored.args } : {}),
    };
  }

  const fallbackMeta = getFallbackLaunchMeta(resolvedProvider);
  if (fallbackMeta) {
    return {
      ...session,
      ...(resolvedProvider ? { __provider: resolvedProvider } : {}),
      ...(fallbackMeta.profileId ? { __launchProfileId: fallbackMeta.profileId } : {}),
      ...(fallbackMeta.args.length > 0 ? { __launchArgs: fallbackMeta.args } : {}),
    };
  }

  return resolvedProvider && session.__provider !== resolvedProvider
    ? { ...session, __provider: resolvedProvider }
    : session;
};

const applyStoredLaunchMetaToProjects = (
  projects: Project[],
  storedMap?: StoredSessionLaunchMetaMap,
): Project[] => projects.map((project) => ({
  ...project,
  sessions: (project.sessions || []).map((session) =>
    applyStoredLaunchMetaToSession(session, 'claude', project.name, storedMap),
  ),
  codexSessions: (project.codexSessions || []).map((session) =>
    applyStoredLaunchMetaToSession(session, 'codex', project.name, storedMap),
  ),
}));

const persistSessionLaunchMeta = (
  session: ProjectSession | null,
  projectName?: string,
  storedMap?: StoredSessionLaunchMetaMap,
) => {
  if (!session?.id || session.id.startsWith('new-session-')) {
    return;
  }

  const provider = session.__provider;
  if (provider !== 'claude' && provider !== 'codex') {
    return;
  }

  const args = normalizeLaunchArgs(session.__launchArgs);
  const profileId = typeof session.__launchProfileId === 'string' && session.__launchProfileId.trim().length > 0
    ? session.__launchProfileId
    : null;

  if (args.length === 0 && !profileId) {
    return;
  }

  const nextMap = {
    ...(storedMap || readStoredLaunchMeta()),
    [session.id]: {
      args,
      profileId,
      provider,
      projectName,
      updatedAt: Date.now(),
    },
  };

  writeStoredLaunchMeta(nextMap);
};

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.name !== prevProject.name ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions)
    );
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
  ];
};

const inferProviderFromProjectSession = (
  project: Project | null,
  sessionId: string | undefined,
): ProjectSession['__provider'] | undefined => {
  if (!project || !sessionId) {
    return undefined;
  }

  if ((project.codexSessions || []).some((session) => session.id === sessionId)) {
    return 'codex';
  }
  if ((project.sessions || []).some((session) => session.id === sessionId)) {
    return 'claude';
  }
  return undefined;
};

const findSessionInProject = (
  project: Project,
  targetSessionId: string,
  preferredProvider?: SessionProvider,
): { session: ProjectSession; provider: SessionProvider } | null => {
  const providerSources: Array<{ provider: SessionProvider; sessions: ProjectSession[] }> = [
    { provider: 'codex', sessions: project.codexSessions || [] },
    { provider: 'claude', sessions: project.sessions || [] },
  ];

  const orderedProviders: SessionProvider[] = preferredProvider
    ? [preferredProvider, ...providerSources.map((item) => item.provider).filter((provider) => provider !== preferredProvider)]
    : providerSources.map((item) => item.provider);

  for (const provider of orderedProviders) {
    const source = providerSources.find((item) => item.provider === provider);
    if (!source) {
      continue;
    }
    const matched = source.sessions.find((session) => session.id === targetSessionId);
    if (matched) {
      return { session: matched, provider };
    }
  }

  return null;
};

const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find((project) => project.name === selectedProject.name);
  const updatedSelectedProject = updatedProjects.find((project) => project.name === selectedProject.name);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = getProjectSessions(currentSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );
  const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );

  if (!currentSelectedSession || !updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage,
  activeSessions,
}: UseProjectsStateArgs) {
  const ACTIVE_TAB_STORAGE_KEY = 'openwork-active-tab';
  const getInitialTab = (): AppTab => {
    if (typeof window === 'undefined') {
      return sessionId ? 'chat' : 'shell';
    }
    try {
      const stored = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) as AppTab | null;
      const validTabs: AppTab[] = ['chat', 'files', 'shell', 'git', 'tasks', 'preview', 'hybrid'];
      if (stored && validTabs.includes(stored)) {
        return stored;
      }
    } catch {
      // Ignore storage errors and fallback to route-aware default below.
    }
    return sessionId ? 'chat' : 'shell';
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTabState] = useState<AppTab>(getInitialTab);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      setIsLoadingProjects(true);
      const response = await api.projects();
      const projectData = applyStoredLaunchMetaToProjects((await response.json()) as Project[]);

      setProjects((prevProjects) => {
        if (prevProjects.length === 0) {
          return projectData;
        }

        return projectsHaveChanges(prevProjects, projectData, true)
          ? projectData
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  const openSettings = useCallback((tab = 'agents') => {
    setSettingsInitialTab(tab);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const setActiveTab = useCallback((nextTab: SetStateAction<AppTab>) => {
    setActiveTabState((prevTab) => {
      const resolvedTab = typeof nextTab === 'function'
        ? (nextTab as (current: AppTab) => AppTab)(prevTab)
        : nextTab;

      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, resolvedTab);
        } catch {
          // Ignore storage errors and keep UI responsive.
        }
      }

      return resolvedTab;
    });
  }, []);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    if (latestMessage.type === 'loading_progress') {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === 'complete') {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, 500);
      }

      return;
    }

    if (latestMessage.type !== 'projects_updated') {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;

    if (projectsMessage.changedFile && selectedSession && selectedProject) {
      const normalized = projectsMessage.changedFile.replace(/\\/g, '/');
      const changedFileParts = normalized.split('/');

      if (changedFileParts.length >= 2) {
        const filename = changedFileParts[changedFileParts.length - 1];
        const changedSessionId = filename.replace('.jsonl', '');

        if (changedSessionId === selectedSession.id) {
          const isSessionActive = activeSessions.has(selectedSession.id);

          if (!isSessionActive) {
            setExternalMessageUpdate((prev) => prev + 1);
          }
        }
      }
    }

    const hasActiveSession =
      (selectedSession && activeSessions.has(selectedSession.id)) ||
      (activeSessions.size > 0 && Array.from(activeSessions).some((id) => id.startsWith('new-session-')));

    const updatedProjects = applyStoredLaunchMetaToProjects(projectsMessage.projects);

    if (
      hasActiveSession &&
      !isUpdateAdditive(projects, updatedProjects, selectedProject, selectedSession)
    ) {
      return;
    }

    setProjects(updatedProjects);

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project) => project.name === selectedProject.name,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      setSelectedProject(updatedSelectedProject);
    }

    if (!selectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      (session) => session.id === selectedSession.id,
    );

    if (!updatedSelectedSession) {
      // Keep the currently routed/active session stable while backend indices catch up.
      // If URL already points to a session, do not clear selectedSession just because
      // project indices have not materialized that session yet.
      const hasRoutedSession = Boolean(sessionId);
      const isProtectedActiveSession = activeSessions.has(selectedSession.id);

      if (!hasRoutedSession && !isProtectedActiveSession) {
        setSelectedSession(null);
      }
    }
  }, [latestMessage, selectedProject, selectedSession, activeSessions, projects, sessionId]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    const isPromotingTemporarySession =
      typeof selectedSession?.id === 'string' &&
      selectedSession.id.startsWith('new-session-') &&
      selectedSession.id !== sessionId;
    const preservedLaunchArgs = isPromotingTemporarySession && Array.isArray(selectedSession?.__launchArgs)
      ? selectedSession.__launchArgs
      : [];
    const preservedLaunchProfileId =
      isPromotingTemporarySession && typeof selectedSession?.__launchProfileId === 'string'
        ? selectedSession.__launchProfileId
        : null;

    const preferredProvider = selectedSession?.id === sessionId
      ? selectedSession.__provider
      : undefined;

    for (const project of projects) {
      const matchedSession = findSessionInProject(project, sessionId, preferredProvider);
      if (!matchedSession) {
        continue;
      }

      const shouldUpdateProject = selectedProject?.name !== project.name;
      const shouldUpdateSession =
        selectedSession?.id !== sessionId || selectedSession.__provider !== matchedSession.provider;

      if (shouldUpdateProject) {
        setSelectedProject(project);
      }
      const hydratedMatchedSession = applyStoredLaunchMetaToSession(
        {
          ...matchedSession.session,
          __provider: matchedSession.provider,
          ...(preservedLaunchArgs.length > 0 ? { __launchArgs: preservedLaunchArgs } : {}),
          ...(preservedLaunchProfileId ? { __launchProfileId: preservedLaunchProfileId } : {}),
        },
        matchedSession.provider,
        project.name,
      );

      persistSessionLaunchMeta(hydratedMatchedSession, project.name);

      if (shouldUpdateSession) {
        setSelectedSession(hydratedMatchedSession);
      }
      return;
    }
  }, [sessionId, projects, selectedProject?.name, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');
    },
    [navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      const isTemporarySession =
        typeof session.id === 'string' && session.id.startsWith('new-session-');
      const { __launchArgs: _launchArgs, __launchProfileId: _launchProfileId, ...sessionWithoutLaunchMeta } =
        session as ProjectSession & { __launchArgs?: unknown; __launchProfileId?: unknown };
      const sessionProject = session.__projectName
        ? projects.find((project) => project.name === session.__projectName) || null
        : selectedProject;
      const inferredProvider = inferProviderFromProjectSession(sessionProject, session.id);
      const savedProvider = localStorage.getItem('selected-provider');
      const fallbackProvider: ProjectSession['__provider'] =
        session.__provider ||
        (savedProvider === 'codex' ? 'codex' : 'claude');
      let normalizedSession: ProjectSession = {
        ...sessionWithoutLaunchMeta,
        __provider: inferredProvider || fallbackProvider,
      };

      if (isTemporarySession) {
        if (typeof _launchProfileId === 'string') {
          normalizedSession.__launchProfileId = _launchProfileId;
        }
        if (Array.isArray(_launchArgs)) {
          normalizedSession.__launchArgs = _launchArgs;
        }
      }

      normalizedSession = applyStoredLaunchMetaToSession(
        normalizedSession,
        normalizedSession.__provider,
        sessionProject?.name || selectedProject?.name,
      );
      persistSessionLaunchMeta(normalizedSession, sessionProject?.name || selectedProject?.name);
      setSelectedSession(normalizedSession);

      navigate(`/session/${normalizedSession.id}`);
    },
    [navigate, projects, selectedProject],
  );

  const handleNewSession = useCallback(
    (project: Project, provider?: string, launchOptions?: SessionLaunchOptions) => {
      setSelectedProject(project);
      const normalizedProvider = (provider || '').trim();
      const isPlainShell =
        normalizedProvider === 'plain' ||
        normalizedProvider === 'plain-shell';
      const savedProvider =
        typeof window !== 'undefined'
          ? window.localStorage.getItem('selected-provider')
          : null;
      const fallbackProvider = savedProvider === 'codex' ? 'codex' : 'claude';
      const requestedProvider =
        normalizedProvider === 'codex' || normalizedProvider === 'claude'
          ? normalizedProvider
          : '';
      const targetProvider = !isPlainShell
        ? (requestedProvider || fallbackProvider)
        : '';
      const supportsLaunchProfiles = targetProvider === 'claude' || targetProvider === 'codex';
      const launchProfileId = supportsLaunchProfiles ? launchOptions?.profileId : undefined;
      const launchArgs = supportsLaunchProfiles
        ? (() => {
            const providerProfiles = loadSessionLaunchProfilesByProvider(targetProvider);
            const selectedProfileId = launchProfileId || providerProfiles.defaultProfileId;
            return mergeSessionLaunchArgs(providerProfiles.profiles, selectedProfileId, launchOptions?.args || []);
          })()
        : [];

      if (targetProvider) {
        // Create a temporary session object to launch CLI
        const tempSession: ProjectSession = {
          id: `new-session-${Date.now()}`,
          __provider: targetProvider as ProjectSession['__provider'],
          __projectName: project.name,
          __launchProfileId: launchProfileId || null,
          __launchArgs: launchArgs,
        };
        setSelectedSession(tempSession);
        setActiveTab('chat');
        navigate(`/session/${tempSession.id}`);
      } else {
        setSelectedSession(null);
        setActiveTab('shell');
        navigate('/');
      }
    },
    [navigate, setActiveTab],
  );

  const handleProjectCreated = useCallback(
    async (project?: Project) => {
      if (project?.name) {
        const normalizedProject: Project = {
          ...project,
          name: project.name,
          displayName: project.displayName || project.name,
          fullPath: project.fullPath || project.path || '',
          path: project.path || project.fullPath || '',
          sessions: project.sessions || [],
          codexSessions: project.codexSessions || [],
          sessionMeta: project.sessionMeta || { hasMore: false, total: 0 },
        };

        setProjects((prevProjects) => {
          const existingIndex = prevProjects.findIndex((item) => item.name === normalizedProject.name);
          if (existingIndex === -1) {
            return [...prevProjects, normalizedProject];
          }

          const nextProjects = [...prevProjects];
          nextProjects[existingIndex] = {
            ...nextProjects[existingIndex],
            ...normalizedProject,
          };
          return nextProjects;
        });

        setSelectedProject(normalizedProject);
        setSelectedSession(null);
      }

      await fetchProjects();
    },
    [fetchProjects],
  );

  const handleSessionDelete = useCallback(
    (projectName: string, sessionIdToDelete: string, provider: SessionProvider) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => {
          if (project.name !== projectName) {
            return project;
          }

          const nextClaudeSessions =
            provider === 'claude'
              ? project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? []
              : project.sessions ?? [];
          const nextCodexSessions =
            provider === 'codex'
              ? project.codexSessions?.filter((session) => session.id !== sessionIdToDelete) ?? []
              : project.codexSessions ?? [];

          return {
            ...project,
            sessions: nextClaudeSessions,
            codexSessions: nextCodexSessions,
            sessionMeta: {
              ...project.sessionMeta,
              total: Math.max(
                0,
                (project.sessionMeta?.total as number | undefined ?? 0) - (provider === 'claude' ? 1 : 0),
              ),
            },
          };
        }),
      );
    },
    [navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = applyStoredLaunchMetaToProjects((await response.json()) as Project[]);

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, freshProjects, true) ? freshProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = freshProjects.find((project) => project.name === selectedProject.name);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession = applyStoredLaunchMetaToSession(
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider },
          selectedSession.__provider,
          refreshedProject.name,
        );

        persistSessionLaunchMeta(normalizedRefreshedSession, refreshedProject.name);

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [selectedProject, selectedSession]);

  const handleProjectDelete = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.name !== projectName));
    },
    [navigate, selectedProject?.name],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onProjectDelete: handleProjectDelete,
      onProjectCreated: handleProjectCreated,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => openSettings('agents'),
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      handleSessionSelect,
      handleSidebarRefresh,
      handleProjectCreated,
      isLoadingProjects,
      loadingProgress,
      openSettings,
      projects,
      selectedProject,
      selectedSession,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    isLoadingProjects,
    loadingProgress,
    settingsInitialTab,
    externalMessageUpdate,
    setActiveTab,
    openSettings,
    fetchProjects,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleProjectCreated,
    handleSidebarRefresh,
  };
}
