import { Select } from "./components/ui/Select";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  CatalogVisibility,
  ProviderCapability,
  ProviderId,
  Session,
  Snapshot,
} from "@threadterm/protocol";
import {
  openWindow,
  onDesktopNavigate,
  onWindowState,
  operationId,
  request,
  snapshot,
  subscribeEvents,
  windowAction,
  windowState,
} from "./bridge";
import { FileWorkspace } from "./components/FileWorkspace";
import { PaneWorkspace } from "./components/PaneWorkspace";
import type { PaneLayout } from "@threadterm/protocol";
import { SessionConfigDialog } from "./components/SessionConfigDialog";
import { WorktreeScope } from "./components/WorktreeScope";
import { SessionActions } from "./components/SessionActions";
import { DesktopCompanion } from "./components/DesktopCompanion";
import { HistoryRail } from "./components/HistoryRail";
import { SessionHistoryRail } from "./components/SessionHistoryRail";
import { ProjectCatalog } from "./components/ProjectCatalog";
import {
  addSessionTab,
  presentationRequest,
  routeFromSearch,
  sameWorkspace,
  sessionIdFromLayout,
  sessionViewState,
  upsertSession,
} from "./presentation";
import { applyThemeTokens, customTheme } from "./themes";
import { PresetRestoreDialog } from "./components/PresetRestoreDialog";
import { sessionIds as presetSessionIds } from "./presetRestore";
import { SettingsDialog } from "./components/SettingsDialog";
import { I18nProvider, translate, useTranslation, type Locale } from "./i18n";
import { confirmCloseEditors } from "./dirtyEditors";
import { argumentLines, commandLines, commandPreset, commandPresets, type CommandPresetId } from "./commandPresets";
import { attentionFromEvent, shouldPresentAttention, type Attention } from "./attentionState";
import { AttentionToast } from "./components/AttentionToast";
import { manualSessionOrder, neighborProjectSession, reorderProjectSessions } from "./sessionOrdering";
import {
  lastActiveSessionId,
  nextSessionId,
  pinnedSessions,
  visibleSessions,
  type SessionScope,
  type SessionSort,
} from "./navigation";
import { isActionableInboxItem } from "./inboxVisibility";
import { sessionsInProjectScope, unreadInboxInScope } from "./projectScope";
import { AgentIcon, Icon } from "./components/PrototypeIcon";
import { UsagePanel } from "./components/UsagePanel";
import { ProjectOverview } from "./components/ProjectOverview";
import { AllTerminalsPage } from "./components/AllTerminalsPage";
import { InboxPage } from "./components/InboxPage";
import { ImportedHistoryView } from "./components/ImportedHistoryView";
import { SessionWorkspace } from "./components/SessionWorkspace";
import { PresetsPage } from "./components/PresetsPage";
import { SessionCreateDialog } from "./components/SessionCreateDialog";
import { AddProjectDialog } from "./components/AddProjectDialog";
import { WorkbenchPage } from "./components/WorkbenchPage";
import { AccountMenu, NotificationMenu } from "./components/ShellMenus";
import { CommandPalette } from "./components/CommandPalette";
import { useSupervision } from "./useSupervision";
import { parseSupervision } from "./supervision";
import { visibleCatalogSnapshot } from "./catalogVisibility";
import { sessionWorkspaceKey } from "./sessionFileViews";

const TerminalSurface = lazy(async () => ({
  default: (await import("./components/TerminalSurface")).TerminalSurface,
}));
const ChatView = lazy(async () => ({
  default: (await import("./components/ChatView")).ChatView,
}));

type Route = {
  kind: "all" | "inbox" | "project" | "session" | "workspace" | "presets" | "workbench";
  id?: string;
  scope?: SessionScope;
  worktreePath?: string;
};
const PROVIDERS: ProviderId[] = [
  "codex",
  "claude",
  "kimi",
  "gemini",
  "opencode",
  "shell",
  "grok",
  "custom",
];
const active = (status: Session["status"]) =>
  ["starting", "running", "idle", "waiting"].includes(status);
const displayProvider = (provider: string) =>
  provider === "claude"
    ? "Claude Code"
    : provider === "opencode"
      ? "OpenCode"
      : provider[0].toUpperCase() + provider.slice(1);
const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

export function App() {
  const floatingWindow = new URLSearchParams(window.location.search).get("floating") === "1";
  const nativeChrome = new URLSearchParams(window.location.search).get("chrome") === "native";
  const [windowMaximized, setWindowMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    void windowState().then((state) => { if (!disposed) setWindowMaximized(state.maximized); });
    const unsubscribe = onWindowState((state) => setWindowMaximized(state.maximized));
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const [rawData, setData] = useState<Snapshot>();
  const [catalogVisibility, setCatalogVisibility] = useState<CatalogVisibility[]>([]);
  const data = rawData ? visibleCatalogSnapshot(rawData, catalogVisibility) : undefined;
  const [route, setRoute] = useState<Route>(() =>
    {const initial=routeFromSearch(window.location.search);return initial.kind==="all"?{kind:"workbench"}:initial;},
  );
  const [scopeProjectId, setScopeProjectId] = useState<string>();
  const [error, setError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [creatorDefaults, setCreatorDefaults] = useState<{projectId?:string;path?:string;provider?:ProviderId;title?:string}>();
  const [shellMenu,setShellMenu]=useState<{kind:"notifications"|"account";anchor:HTMLElement}>();
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [recentIds, setRecentIds] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem("threadterm.v3.recent-session-ids") ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 12) : []; } catch { return []; } });
  useEffect(() => { try { localStorage.setItem("threadterm.v3.recent-session-ids", JSON.stringify(recentIds)); } catch { /* Navigation still works when browser storage is unavailable. */ } }, [recentIds]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false);
  const [historyTargetId, setHistoryTargetId] = useState<string>();
  const [companionOpen, setCompanionOpen] = useState(true);
  const [backgroundPresentation, setBackgroundPresentation] = useState<{
    sessionId: string;
    workspacePath?: string;
  }>();
  const [presetLayout, setPresetLayout] = useState<PaneLayout>();
  const [navigationEpoch,setNavigationEpoch]=useState(0);
  const [presetCommands, setPresetCommands] = useState<string[]>([]);
  const presetLayoutRef = useRef<PaneLayout | undefined>(undefined);
  presetLayoutRef.current = presetLayout;
  const [presetCandidate, setPresetCandidate] =
    useState<Snapshot["presets"][number]>();
  const [attention, setAttention] = useState<Attention>();
  const supervision = parseSupervision(data?.settings.supervision);
  const supervisionState = useSupervision(data?.sessions ?? [], data?.settings.supervision);
  const inboxInitialized = useRef(false);
  const refreshGeneration = useRef(0);
  const seenAttention = useRef(new Set<string>());
  const lastModifierUp = useRef(0);
  const modifierChordUsed = useRef(false);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      if (generation === refreshGeneration.current) setError(undefined);
      const [next, visibility] = await Promise.all([snapshot(), request("catalog.visibility.list", {})]);
      if (generation !== refreshGeneration.current) return;
      if (!inboxInitialized.current) {
        next.inbox.forEach((item) => seenAttention.current.add(item.id));
        inboxInitialized.current = true;
      }
      setData(next);
      setCatalogVisibility(visibility);
    } catch (caught) {
      if (generation !== refreshGeneration.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to connect to ThreadTerm runtime.",
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    return subscribeEvents((event) => {
      if (event.event === "state.changed") void refresh();
    });
  }, [refresh]);
  const routedWorkspace =
    route.kind === "workspace"
      ? data?.workspaces.find((item) => item.id === route.id)
      : undefined;
  const routeSessionId =
    route.kind === "session"
      ? route.id
      : routedWorkspace
        ? sessionIdFromLayout(routedWorkspace.layout)
        : undefined;
  const session = routeSessionId
    ? data?.sessions.find((item) => item.id === routeSessionId)
      ?? rawData?.sessions.find((item) => item.id === routeSessionId)
    : undefined;
  const sessionView = sessionViewState(route.kind, session);
  const workspaceData = data && session && !data.sessions.some((item) => item.id === session.id)
    ? upsertSession(data, session)
    : data;
  const project =
    route.kind === "project"
      ? data?.projects.find((item) => item.id === route.id)
      : undefined;
  const systemDark = useSystemDark();
  const theme =
    data?.settings.theme === "light"
      ? "light"
      : data?.settings.theme === "dark"
        ? "dark"
        : systemDark
          ? "dark"
          : "light";
  const locale: Locale = data?.settings.language === "en" ? "en" : "zh-CN";
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const themeTokens = data ? customTheme(data.settings) : undefined;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.customTheme = themeTokens
      ? "true"
      : "false";
    document.documentElement.lang = locale;
    applyThemeTokens(themeTokens);
  }, [locale, theme, themeTokens]);
  const scopeSessions = data?.sessions.filter(item=>!scopeProjectId||item.projectId===scopeProjectId)??[];
  const scopeSessionIds = new Set(scopeSessions.map(item=>item.id));
  const scopedData = data&&scopeProjectId?{...data,sessions:scopeSessions,inbox:data.inbox.filter(item=>scopeSessionIds.has(item.sessionId))}:data;
  const inboxUnread = scopedData?.inbox.filter((item) => isActionableInboxItem(item)).length ?? 0;
  useEffect(() => { if (route.kind === "inbox") setAttention(undefined); }, [route.kind]);
  const companionEnabled = (data?.settings.desktopCompanion as { enabled?: unknown } | undefined)?.enabled === true;
  const companionText = locale === "zh-CN"
    ? { enable: "启用桌面伴侣", enabled: "打开桌面伴侣" }
    : { enable: "Enable desktop companion", enabled: "Open desktop companion" };
  const toggleCompanion = async () => {
    if (!data) return;
    await request("settings.update", {
      patch: { desktopCompanion: { enabled: !companionEnabled } },
      expectedRevision: data.settings.revision,
      operationId: operationId(),
    });
    setCompanionOpen(true);
  };
  /** "Back" from a session returns to its branch (worktree) home page, like the sidebar's branch row; sessions
   * outside a project go to All terminals. */
  const sessionHome = (target?: Session): Route => {
    const home = target?.projectId ? data?.projects.find(item => item.id === target.projectId) : undefined;
    return home ? {kind: "project", id: home.id, worktreePath: target!.worktreePath ?? home.path} : {kind: "all"};
  };
  const navigationState = useRef({route, session, data});
  navigationState.current = {route, session, data};
  const navigate = useCallback(async (next: Route) => {
    const current = navigationState.current;
    const destination = next.kind === 'session' ? current.data?.sessions.find(item => item.id === next.id) : undefined;
    const retained = current.route.kind === 'session' && current.session && destination && current.data
      && sessionWorkspaceKey(current.session, current.data.projects) === sessionWorkspaceKey(destination, current.data.projects);
    if (!retained && !(await confirmCloseEditors())) return;
    if (next.kind !== "session" || !next.id || !presetLayoutRef.current || !presetSessionIds(presetLayoutRef.current).includes(next.id)) {
      setPresetLayout(undefined); setPresetCommands([]);
    }
    setRoute(next);
    setNavigationEpoch(value=>value+1);
    if (next.kind === "session" && next.id)
      setRecentIds((current) =>
        [next.id!, ...current.filter((id) => id !== next.id)].slice(0, 8),
      );
  }, []);
  const openCreatedSession = useCallback((created: Session) => {
    setData((current) => (current ? upsertSession(current, created) : current));
    void navigate({ kind: "session", id: created.id });
  }, [navigate]);
  useEffect(
    () => subscribeEvents((event) => {
      const next = attentionFromEvent(event);
      if (!next) return;
      if (shouldPresentAttention({ attention: next, routeKind: route.kind, routeId: route.id, initialized: inboxInitialized.current, seen: seenAttention.current })) setAttention(next);
      void refresh();
    }),
    [refresh, route.kind, route.id],
  );
  useEffect(
    () =>
      subscribeEvents((event) => {
        if (floatingWindow) return;
        if (event.event !== "presentation.requested") return;
        const request = presentationRequest(event.data);
        if (!request) return;
        if (request.presentation === "focused") {
          setSettingsOpen(false);
          void navigate({ kind: "session", id: request.sessionId });
          return;
        }
        setBackgroundPresentation({
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
        });
      }),
    [floatingWindow, navigate],
  );
  useEffect(
    () => onDesktopNavigate((target) => {
      if (target.action === "command-palette") {setPaletteOpen(true);return;}
      if (target.sessionId) {setSettingsOpen(false);void navigate({ kind: "session", id: target.sessionId });}
      else if (target.workspaceId) {setSettingsOpen(false);void navigate({ kind: "workspace", id: target.workspaceId });}
    }),
    [navigate],
  );
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key !== "Control" && event.key !== "Meta")
        modifierChordUsed.current = true;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control" && event.key !== "Meta") return;
      if (modifierChordUsed.current) {
        modifierChordUsed.current = false;
        lastModifierUp.current = 0;
        return;
      }
      const now = Date.now();
      if (now - lastModifierUp.current >= 300) {
        lastModifierUp.current = now;
        return;
      }
      lastModifierUp.current = 0;
      const target = lastActiveSessionId(data?.sessions ?? [], recentIds, routeSessionId);
      if (target) void navigate({ kind: "session", id: target });
    };
    addEventListener("keydown", keyDown, { capture: true });
    addEventListener("keyup", keyUp, { capture: true });
    return () => {
      removeEventListener("keydown", keyDown, { capture: true });
      removeEventListener("keyup", keyUp, { capture: true });
    };
  }, [data?.sessions, navigate, recentIds, routeSessionId]);
  return (
    <I18nProvider locale={locale}>
      <div className={`${floatingWindow ? "app-shell floating-shell" : "app-shell"}${windowMaximized ? " is-maximized" : ""}${nativeChrome ? " native-chrome" : ""}`}>
        <header className="titlebar app-chrome">
          <div className="drag-region"><span className="chrome-title">ThreadTerm</span></div>
          <div className="window-controls">
            <button
              aria-label={t("minimize")}
              onClick={() => void windowAction("minimize")}
            >
              <Icon name="minimize" />
            </button>
            <button
              aria-label={t("maximize")}
              onClick={() => void windowAction("maximize")}
            >
              <Icon name="maximize" />
            </button>
            <button
              aria-label={t("closeWindow")}
              onClick={() => void windowAction("close")}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <aside className="sidebar">
          <div className="side-head">
            <button className="brand-home" onClick={() => void navigate({ kind: "workbench" })}><span className="brand-mark"><Icon name="terminal" /></span>ThreadTerm</button>
            <button className="icon-btn" aria-label={t("commandPalette")} onClick={() => setPaletteOpen(true)}><Icon name="search" /></button>
            <button aria-label={t("inbox")} className="icon-btn" aria-expanded={shellMenu?.kind==="notifications"} onClick={event => setShellMenu(shellMenu?.kind==="notifications"?undefined:{kind:"notifications",anchor:event.currentTarget})}><Icon name="bell" />{inboxUnread > 0 && <i className="bell-badge">{inboxUnread}</i>}</button>
          </div>
          <div className="side-scroll"><nav className="side-nav" aria-label={t("primaryNavigation")}>
            <button className="nav-item new" onClick={() => setCreatorOpen(true)}><Icon name="plus" />{locale==="zh-CN"?"新建终端":"New terminal"}</button>
            <button
              className={route.kind === "inbox" ? "nav-item active" : "nav-item"}
              onClick={() => void navigate({ kind: "inbox" })}
            >
              <Icon name="inbox" /><span className="grow">{t("inbox")}</span>{inboxUnread > 0 && <span className="badge amber">{inboxUnread}</span>}
            </button>
            <button
              className={route.kind === "all" ? "nav-item active" : "nav-item"}
              onClick={() => void navigate({ kind: "all" })}
            >
              <Icon name="terminal" />{locale==="zh-CN"?"所有终端":"All terminals"}
            </button>
            <button className={`nav-item${route.kind === "presets" ? " active" : ""}`} onClick={() => void navigate({kind:"presets"})}><Icon name="layers" />{locale === "zh-CN" ? "工作预设" : "Work presets"}</button>
          </nav>
          <ProjectCatalog
            sessions={rawData?.sessions}
            visibility={catalogVisibility}
            onChanged={() => void refresh()}
            selectedProjectId={project?.id ?? session?.projectId}
            selectedSessionId={session?.id}
            selectedWorktreePath={route.kind === "project" ? route.worktreePath : session?.worktreePath}
            onAll={() => void navigate({ kind: "all" })}
            onProject={(id) => void navigate({ kind: "project", id })}
            onWorktree={(id, worktreePath) => void navigate({ kind: "project", id, worktreePath })}
            onSession={(id) => void navigate({ kind: "session", id })}
            onScopeChange={setScopeProjectId}
            onAddProject={() => setProjectCreatorOpen(true)}
            onNewSession={(projectId,path) => {const selected=data?.projects.find(item=>item.id===projectId);if(selected)setCreatorDefaults({projectId:selected.id,path:path??selected.path});setCreatorOpen(true);}}
          />
          </div>
          <div className="side-foot"><button className="user-row" aria-expanded={shellMenu?.kind==="account"} onClick={event => setShellMenu(shellMenu?.kind==="account"?undefined:{kind:"account",anchor:event.currentTarget})}><span className="avatar">本</span><span className="grow">{locale === "zh-CN" ? "本地用户" : "Local user"}</span><Icon name="chevron" /></button></div>
        </aside>
        <main className="content main">
          <div className="toolbar legacy-toolbar">
            <div>
              {route.kind === "all"
                ? t("allSessionsTitle")
                : route.kind === "inbox"
                  ? t("inboxTitle")
                  : (project?.name ?? session?.title ?? "ThreadTerm")}
            </div>
            <div className="toolbar-actions">
              <button
                onClick={() => setHistoryOpen((value) => {
                  const next = !value;
                  if (next) setSessionHistoryOpen(false);
                  return next;
                })}
                aria-pressed={historyOpen}
              >
                {t("nativeHistory")}
              </button>
              <button
                onClick={() => setSessionHistoryOpen((value) => {
                  const next = !value;
                  if (next) setHistoryOpen(false);
                  return next;
                })}
                aria-pressed={sessionHistoryOpen}
              >
                {locale === "zh-CN" ? "会话历史" : "Session history"}
              </button>
              <button
                onClick={() => companionEnabled && !companionOpen ? setCompanionOpen(true) : void toggleCompanion()}
                aria-pressed={companionEnabled}
              >
                {companionEnabled ? companionText.enabled : companionText.enable}
              </button>
              <button onClick={() => setSettingsOpen(true)}>
                {t("settings")}
              </button>
              <Select
                aria-label={t("presets")}
                value=""
                onChange={(event) => {
                  const preset = data?.presets.find(
                    (item) => item.id === event.target.value,
                  );
                  if (preset) setPresetCandidate(preset);
                }}
              >
                <option value="">{t("presets")}</option>
                {data?.presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {error ? (
            <Unavailable onRetry={refresh} />
          ) : !data ? (
            <Loading />
          ) : sessionView === "ready" && session ? (
            <SessionWorkspace
              key={sessionWorkspaceKey(session,data.projects)} session={session} data={workspaceData??data} theme={theme}
              navigationKey={navigationEpoch}
              onActiveSession={id=>{
                if(route.kind!=='session'||route.id===id)return;
                const target=(workspaceData??data).sessions.find(item=>item.id===id);
                if(!target)return;
                // Internal focus in this retained workspace must not create a
                // navigation epoch (it would cancel a just-clicked file link).
                // Cross-scope preset tabs do replace the workspace and need the
                // same dirty-file guard as explicit navigation.
                if(sessionWorkspaceKey(target,data.projects)!==sessionWorkspaceKey(session,data.projects))void navigate({kind:'session',id});
                else setRoute({kind:'session',id});
              }}
              onBack={() => void navigate(sessionHome(session))}
              onSelect={(id) => void navigate({kind:"session",id})}
              onProject={(id,worktreePath) => void navigate({kind:"project",id,worktreePath})}
              onChanged={() => void refresh()}
              backgroundPresentation={backgroundPresentation && sameWorkspace(session,backgroundPresentation.workspacePath) ? backgroundPresentation.sessionId : undefined}
              onBackgroundPresented={() => setBackgroundPresentation(undefined)}
              initialLayout={presetLayout}
              pendingCommands={presetCommands}
              onClearCommands={() => setPresetCommands([])}
            />
          ) : sessionView === "opening" ? (
            <SessionOpening onBack={() => void navigate(sessionHome(session))} />
          ) : route.kind === "project" && project ? (
            <ProjectOverview
              key={`${project.id}:${route.worktreePath ?? "root"}`}
              projectId={project.id}
              data={data}
              initialWorktreePath={route.worktreePath}
              onScopeChange={(worktreePath) => void navigate({ kind: "project", id: project.id, worktreePath })}
              onSession={(id) => void navigate({ kind: "session", id })}
              onCreate={(projectId,path) => { setCreatorDefaults({projectId,path}); setCreatorOpen(true); }}
              onInbox={() => void navigate({kind:"inbox"})}
              onChanged={() => void refresh()}
              onRemoved={() => {
                void navigate({ kind: "all" });
                void refresh();
              }}
            />
          ) : route.kind === "workbench" ? (
            <WorkbenchPage data={data} recentIds={recentIds} onProject={id=>void navigate({kind:"project",id})} onSession={id=>void navigate({kind:"session",id})} onCreate={defaults=>{setCreatorDefaults(defaults);setCreatorOpen(true);}} onAddProject={()=>setProjectCreatorOpen(true)} onPreset={setPresetCandidate} onAll={()=>void navigate({kind:"all"})} onInbox={()=>void navigate({kind:"inbox"})} onPresets={()=>void navigate({kind:"presets"})}/>
          ) : route.kind === "presets" ? (
            <PresetsPage data={data} onOpen={setPresetCandidate} onChanged={() => void refresh()} currentLayout={presetLayout}/>
          ) : route.kind === "inbox" ? (
            <InboxPage
              data={scopedData??data}
              onSession={(id) => void navigate({ kind: "session", id })}
              onRead={() => void refresh()}
              supervision={supervision}
              onSupervision={async value=>{await request("settings.update",{patch:{supervision:value},expectedRevision:data.settings.revision,operationId:operationId()});await refresh();}}
              supervisionAlerts={supervisionState.alerts}
            />
          ) : data.projects.length === 0 && data.sessions.length === 0 ? (
            <Welcome onStart={() => setProjectCreatorOpen(true)} />
          ) : (
            <AllTerminalsPage
              key={route.scope ?? "all"}
              initialScope={route.scope}
              data={scopedData??data}
              recentIds={recentIds}
              highlightedSessionId={historyTargetId}
              historyOpen={historyOpen}
              onCloseHistory={() => setHistoryOpen(false)}
              onOpenHistory={() => setHistoryOpen(true)}
              onLocalHistory={() => setSessionHistoryOpen(true)}
              onSession={(id) => void navigate({ kind: "session", id })}
              onChanged={() => void refresh()}
            />
          )}
        </main>
        <footer className="statusbar"><span className="sb-note"><span className="runtime-dot" />{error ? t("runtimeUnavailable") : data ? t("runtimeConnected") : t("connecting")}</span><span className="top-spacer" /><span>{locale === "zh-CN" ? "本地运行" : "Local runtime"}</span></footer>
        {data && companionEnabled && companionOpen && (
          <DesktopCompanion
            sessions={data.sessions}
            unreadInbox={inboxUnread}
            locale={locale}
            onOpenInbox={() => void navigate({ kind: "inbox" })}
            onOpenActive={() => void navigate({ kind: "all", scope: "active" })}
            onClose={() => setCompanionOpen(false)}
          />
        )}
        {attention && <AttentionToast attention={attention} session={data?.sessions.find(candidate => candidate.id === attention.sessionId)} locale={locale} onClose={() => setAttention(undefined)} onOpen={() => { setAttention(undefined); void navigate({ kind: "session", id: attention.sessionId }); }} />}
        {!floatingWindow && route.kind === "all" && sessionHistoryOpen && data && (
          <SessionHistoryRail
            data={data}
            onClose={() => setSessionHistoryOpen(false)}
            onNavigateAll={(sessionId, scope) => {
              setHistoryTargetId(sessionId);
              void navigate({ kind: "all", scope });
            }}
            onChanged={() => void refresh()}
          />
        )}
        {shellMenu&&data&&(shellMenu.kind==='account'?<AccountMenu data={data} anchor={shellMenu.anchor} onClose={()=>setShellMenu(undefined)} onChanged={()=>void refresh()} onSettings={()=>{setShellMenu(undefined);setSettingsOpen(true);}}/>:<NotificationMenu data={data} anchor={shellMenu.anchor} onClose={()=>setShellMenu(undefined)} onChanged={()=>void refresh()} onSession={id=>{setShellMenu(undefined);void navigate({kind:"session",id});}} onInbox={()=>{setShellMenu(undefined);void navigate({kind:"inbox"});}}/>)}
        {paletteOpen && data && <CommandPalette data={data} workbench={route.kind === "session" || route.kind === "workspace"} onClose={()=>setPaletteOpen(false)} onSession={id=>void navigate({kind:"session",id})} onProject={id=>void navigate({kind:"project",id})} onCreate={()=>setCreatorOpen(true)} onAll={()=>void navigate({kind:"all"})} onInbox={()=>void navigate({kind:"inbox"})} onPresets={()=>void navigate({kind:"presets"})} onSettings={()=>setSettingsOpen(true)}/>}
        {creatorOpen && data && (
          <SessionCreateDialog data={data}
            initialProjectId={creatorDefaults?.projectId} initialPath={creatorDefaults?.path} initialProvider={creatorDefaults?.provider} initialTitle={creatorDefaults?.title}
            onClose={() => {setCreatorOpen(false);setCreatorDefaults(undefined);}}
            onCreated={(created) => {setCreatorOpen(false);setCreatorDefaults(undefined);openCreatedSession(created);void refresh();}}
          />
        )}
        {projectCreatorOpen && (
          <AddProjectDialog
            onClose={() => setProjectCreatorOpen(false)}
            onCreated={(id) => {
              setProjectCreatorOpen(false);
              void navigate({ kind: "project", id });
              void refresh();
            }}
          />
        )}
        {presetCandidate && (
          <PresetRestoreDialog
            preset={presetCandidate}
            projects={data?.projects ?? []}
            sessions={data?.sessions ?? []}
            onClose={() => setPresetCandidate(undefined)}
            onRestored={async (restored) => {
                if (!await confirmCloseEditors()) return;
                setPresetCandidate(undefined);
                setPresetLayout(restored.layout);
                setPresetCommands(restored.commands);
                setRoute({ kind: "session", id: restored.sessionId });
                setRecentIds(current => [restored.sessionId, ...current.filter(id => id !== restored.sessionId)].slice(0, 8));
            }}
          />
        )}
        {settingsOpen && data && (
          <SettingsDialog
            data={data}
            supervisionCounts={supervisionState}
            currentWorkspace={
              session
                ? (() => {
                    const workspace = data.workspaces.find(
                      (item) =>
                        item.projectId === session.projectId &&
                        item.worktreePath === session.worktreePath,
                    );
                    return workspace
                      ? {
                          layout: workspace.layout,
                          sessions: data.sessions
                            .filter(
                              (item) =>
                                item.projectId === session.projectId &&
                                item.worktreePath === session.worktreePath,
                            )
                            .map((item) => ({
                              id: `session-${item.id}`,
                              kind: "session" as const,
                              sessionId: item.id,
                            })),
                        }
                      : undefined;
                  })()
                : undefined
            }
            onClose={() => setSettingsOpen(false)}
            onSaved={refresh}
            onSessionCreated={async (sessionId) => {
              setSettingsOpen(false);
              await navigate({ kind: "session", id: sessionId });
              void refresh();
            }}
          />
        )}
      </div>
    </I18nProvider>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="state">
      <div className="spinner" />
      <strong>{t("connecting")}</strong>
      <p>{t("runtimeMessage")}</p>
    </div>
  );
}
function SessionOpening({ onBack }: { onBack: () => void }) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  return (
    <section className="ws session-screen runtime-workspace" aria-busy="true" aria-label={zh ? "正在打开会话" : "Opening session"}>
      <header className="ws-top">
        <button className="ws-back" onClick={onBack}><Icon name="back" /><span>{zh ? "返回" : "Back"}</span></button>
      </header>
      <div className="state">
        <div className="spinner" />
        <strong>{zh ? "正在打开会话…" : "Opening session…"}</strong>
        <p>{zh ? "会话正在启动，已进入工作区。" : "The session is starting in this workspace."}</p>
      </div>
    </section>
  );
}
function Unavailable({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <div className="state">
      <h1>{t("runtimeUnavailable")}</h1>
      <p>{t("runtimeUnavailableMessage")}</p>
      <button className="primary" onClick={() => void onRetry()}>
        {t("retryConnection")}
      </button>
    </div>
  );
}
function Status({ value }: { value: Session["status"] }) {
  const { t } = useTranslation();
  return <span className={`status ${value}`}>{t(value)}</span>;
}
function Welcome({ onStart }: { onStart: () => void }) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  return <section className="page welcome"><div className="empty"><h1>{zh ? "欢迎使用 ThreadTerm" : "Welcome to ThreadTerm"}</h1><p>{zh ? "从一个目录开始。ThreadTerm 会将项目和会话保存在本地运行时中。" : "Start from a directory. ThreadTerm keeps projects and sessions in the local runtime."}</p><button type="button" className="primary" onClick={onStart}>{zh ? "选择项目目录" : "Choose project directory"}</button><p><small>{zh ? "选择目录不会自动运行命令。" : "Choosing a directory never runs a command automatically."}</small></p></div></section>;
}
function useSystemDark() {
  const [dark, setDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return dark;
}
