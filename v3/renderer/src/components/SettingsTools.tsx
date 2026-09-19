import { Select } from "./ui/Select";
import { useEffect, useRef, useState } from "react";
import type { Session, Snapshot, Worktree } from "@threadterm/protocol";
import { chooseDirectory, openDirectory, operationId, request } from "../bridge";
import { presentationRequest } from "../presentation";
import { displayPath, sameCanonicalScope } from "../projectScope";
import { FileWorkspace } from "./FileWorkspace";
import { Icon } from "./PrototypeIcon";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import { SurfaceDialog } from "./SurfaceDialog";
import "./settings-tools.css";

type Props = { data: Snapshot; onSaved: () => Promise<void> };
type Placement = "workspace" | "window";
type Presentation = "background" | "focused";
type ToolRun = { id: string; cwd: string; placement: Placement; presentation: Presentation };
const RUNS_KEY = "threadterm-v3.settings-tools-runs";

function savedRuns(): Map<string, ToolRun> {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(RUNS_KEY) ?? "[]");
    if (!Array.isArray(values)) return new Map();
    return new Map(values.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const run = value as Partial<ToolRun>;
      return typeof run.id === "string" && typeof run.cwd === "string" && (run.placement === "workspace" || run.placement === "window") && (run.presentation === "background" || run.presentation === "focused") ? [[run.id, run as ToolRun]] : [];
    }));
  } catch { return new Map(); }
}
function persistRuns(runs: Map<string, ToolRun>) { try { localStorage.setItem(RUNS_KEY, JSON.stringify([...runs.values()])); } catch { /* Storage is only a convenience index. */ } }

export function SettingsTools({ data, onSaved }: Props) {
  const zh = data.settings.language !== "en";
  const copy = zh ? cn : en;
  const [projectId, setProjectId] = useState(() => data.projects[0]?.id ?? "");
  const [cwd, setCwd] = useState(() => data.projects[0]?.path ?? "");
  const [placement, setPlacement] = useState<Placement>("workspace");
  const [presentation, setPresentation] = useState<Presentation>("background");
  const [busy, setBusy] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [gitOpen, setGitOpen] = useState(false);
  const [forceTarget, setForceTarget] = useState<Session>();
  const [forceIssue, setForceIssue] = useState<string>();
  const [runVersion, setRunVersion] = useState(0);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const runs = useRef(savedRuns());
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const project = data.projects.find(item => item.id === projectId);
  const runSessions = data.sessions.filter(session => runs.current.has(session.id));
  useEffect(() => {
    if (projectId && !project) {
      setProjectId(data.projects[0]?.id ?? "");
      setCwd(data.projects[0]?.path ?? "");
    }
  }, [data.projects, project, projectId]);
  useEffect(() => {
    let current = true;
    if (!project) { setWorktrees([]); return () => { current = false; }; }
    void request("worktree.list", { projectId: project.id }).then(value => { if (current) setWorktrees(value); }).catch(() => { if (current) setWorktrees([]); });
    return () => { current = false; };
  }, [project]);

  const execute = async (name: string, action: () => Promise<string | undefined>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(name); setIssue(undefined); setForceIssue(undefined); setNotice(undefined);
    try {
      const message = await action();
      if (alive.current && message) setNotice(message);
    } catch (error) {
      if (alive.current) {
        const message = errorMessage(error, copy.failed);
        if (name.startsWith("force-")) setForceIssue(message); else setIssue(message);
      }
    } finally {
      if (alive.current) setBusy(undefined);
      busyRef.current = false;
    }
  };
  const selectProject = (next: string) => {
    setProjectId(next);
    const selected = data.projects.find(item => item.id === next);
    if (selected) setCwd(selected.path);
  };
  const chooseCwd = () => void execute("folder", async () => {
    const selected = await chooseDirectory();
    if (!selected) return undefined;
    if (alive.current) setCwd(selected);
    return copy.folderChosen;
  });
  const requireProject = () => {
    if (!project) throw new Error(copy.projectRequired);
    return project;
  };
  const openExplorer = () => void execute("explorer", async () => {
    await openDirectory(requireProject().id);
    return copy.explorerOpened;
  });
  const openGit = () => void execute("git", async () => {
    const selected = requireProject();
    await request("git.status", { projectId: selected.id });
    if (alive.current) setGitOpen(true);
    return undefined;
  });
  const createTerminal = () => void execute("create", async () => {
    if (!cwd.trim()) throw new Error(copy.cwdRequired);
    const scopedProject = project && [project.path, ...worktrees.map(tree => tree.path)].some(path => sameCanonicalScope(path, cwd)) ? project : undefined;
    const session = await request("session.create", {
      cwd: cwd.trim(), projectId: scopedProject?.id, title: copy.shellTitle, provider: "shell", mode: "terminal", operationId: operationId(),
    });
    runs.current.set(session.id, { id: session.id, cwd: cwd.trim(), placement, presentation });
    persistRuns(runs.current);
    if (alive.current) setRunVersion(version => version + 1);
    await onSaved();
    const shown = presentationRequest({ sessionId: session.id, presentation, workspacePath: session.worktreePath ?? cwd.trim() });
    if (!shown) throw new Error(copy.failed);
    await request("session.present", { ...shown, placement, operationId: operationId() });
    return presentation === "focused" ? copy.createdFocused : copy.createdBackground;
  });
  const showRun = (session: Session) => void execute(`show-${session.id}`, async () => {
    const run = runs.current.get(session.id);
    if (!run) return undefined;
    const shown = presentationRequest({ sessionId: session.id, presentation: "focused", workspacePath: session.worktreePath ?? run.cwd });
    if (!shown) throw new Error(copy.failed);
    await request("session.present", { ...shown, placement: run.placement, operationId: operationId() });
    return copy.shown;
  });
  const endRun = (session: Session, force = false) => void execute(`${force ? "force" : "end"}-${session.id}`, async () => {
    if (!runs.current.has(session.id)) return undefined;
    await request("session.stop", { sessionId: session.id, ...(force ? { force: true } : {}), operationId: operationId() });
    if (force && alive.current) setForceTarget(undefined);
    await onSaved();
    return force ? copy.forced : copy.ended;
  });

  return <section className="settings-tools" aria-label={copy.title}>
    <div className="settings-tools-heading"><h3>{copy.title}</h3><Select aria-label={copy.project} title={displayPath(project?.path)||copy.selectProject} value={projectId} onChange={event=>selectProject(event.target.value)} disabled={Boolean(busy)}><option value="">{copy.selectProject}</option>{data.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></div><p>{copy.toolsHint}</p>
    <div className="tool-row"><span><b>{copy.explorerTitle}</b><small>{copy.explorerHint}</small></span><button className="btn-subtle" type="button" disabled={!project || Boolean(busy)} onClick={openExplorer}><Icon name="folder" />{busy === "explorer" ? copy.opening : copy.openExplorer}</button></div>
    <div className="tool-row"><span><b>{copy.gitTitle}</b><small>{copy.gitHint}</small></span><button className="btn-subtle" type="button" disabled={!project || Boolean(busy)} onClick={openGit}><Icon name="branch" />{busy === "git" ? copy.checking : copy.openGit}</button></div>
    
    <div className="setting-divider" />
    <section className="settings-tool-lifecycle" aria-labelledby="tool-lifecycle-title"><h4 id="tool-lifecycle-title">{copy.lifecycleTitle}</h4><p>{copy.lifecycleHint}</p>
      <label>{copy.cwd}<span className="settings-tools-path"><input value={cwd} onChange={event => setCwd(event.target.value)} disabled={Boolean(busy)} /><button className="btn-subtle" type="button" disabled={Boolean(busy)} onClick={chooseCwd}><Icon name="folder" />{busy === "folder" ? copy.choosing : copy.chooseFolder}</button></span></label>
      <label>{copy.target}<Select value={placement} disabled={Boolean(busy)} onChange={event => setPlacement(event.target.value as Placement)}><option value="workspace">{copy.workspace}</option><option value="window">{copy.window}</option></Select></label><label>{copy.mode}<Select value={presentation} disabled={Boolean(busy)} onChange={event => setPresentation(event.target.value as Presentation)}><option value="background">{copy.background}</option><option value="focused">{copy.focused}</option></Select></label>
      <button className="btn btn-primary" type="button" disabled={Boolean(busy) || !cwd.trim()} onClick={createTerminal}><Icon name="terminal" />{busy === "create" ? copy.creating : copy.create}</button>
      <ul className="settings-tool-runs" aria-label={copy.runList} data-run-version={runVersion}>{runSessions.length ? runSessions.map(session => <RunRow key={session.id} session={session} run={runs.current.get(session.id)!} busy={busy} copy={copy} onShow={() => showRun(session)} onEnd={() => endRun(session)} onForce={() => setForceTarget(session)} />) : <li className="settings-tool-empty">{copy.noRuns}</li>}</ul>
    </section>
    <details className="settings-tool-accounts"><summary>{copy.accounts}</summary><ProviderSettingsPanel data={data} onCreated={async session => { const config = await request("session.config.read", { sessionId: session.id }); const shown = presentationRequest({ sessionId: session.id, presentation: "focused", workspacePath: session.worktreePath ?? config.cwd }); if (!shown) throw new Error(copy.failed); await request("session.present", { ...shown, placement: "workspace", operationId: operationId() }); await onSaved(); }} /></details>
    {notice && <p className="settings-tool-notice" role="status" aria-live="polite">{notice}</p>}{issue && <p className="surface-error" role="alert">{issue}</p>}
    {gitOpen && project && <SurfaceDialog title={copy.gitDialog} subtitle={project.name} icon="branch" size="wide" onClose={() => setGitOpen(false)}><FileWorkspace projectId={project.id} initialView="diff" /></SurfaceDialog>}
    {forceTarget && <SurfaceDialog title={copy.forceTitle} subtitle={forceTarget.title} icon="terminal" size="sm" onClose={() => { if (!busy) { setForceTarget(undefined); setForceIssue(undefined); } }} footer={<><button className="btn" disabled={Boolean(busy)} onClick={() => { setForceTarget(undefined); setForceIssue(undefined); }}>{copy.cancel}</button><button className="btn btn-danger" disabled={Boolean(busy)} onClick={() => endRun(forceTarget, true)}>{busy?.startsWith("force-") ? copy.forcing : copy.force}</button></>}><p>{copy.forceBody}</p><code className="settings-tools-force-cwd">{displayPath(runs.current.get(forceTarget.id)?.cwd ?? forceTarget.worktreePath) || copy.cwdUnknown}</code>{forceIssue && <p className="surface-error" role="alert">{forceIssue}</p>}</SurfaceDialog>}
  </section>;
}

function RunRow({ session, run, busy, copy, onShow, onEnd, onForce }: { session: Session; run: ToolRun; busy?: string; copy: Copy; onShow: () => void; onEnd: () => void; onForce: () => void }) {
  const active = !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status);
  return <li><span><b>{session.title}</b><small>{displayPath(run.cwd)} · {run.placement === "workspace" ? copy.workspace : copy.window} · {run.presentation === "background" ? copy.background : copy.focused} · {active ? copy.active : copy.finished}</small></span><div><button className="btn-subtle" type="button" disabled={Boolean(busy)} onClick={onShow}>{busy === `show-${session.id}` ? copy.showing : copy.show}</button>{active && <><button className="btn-subtle" type="button" disabled={Boolean(busy)} onClick={onEnd}>{busy === `end-${session.id}` ? copy.ending : copy.end}</button><button className="btn-danger" type="button" disabled={Boolean(busy)} onClick={onForce}>{copy.force}</button></>}</div></li>;
}

type Copy = typeof en;
const en = { title: "External tool connections", toolsHint: "Use the selected project for Explorer and local Git. Terminal creation stays local to the directory you choose.", explorerTitle: "Explorer", explorerHint: "Open the selected registered project in Explorer.", opening: "Opening…", openExplorer: "Open Explorer", explorerOpened: "Explorer opened.", project: "Registered project", selectProject: "Choose a registered project", gitTitle: "Built-in Git", gitHint: "Check the selected project, then open its local files and changes.", checking: "Checking…", openGit: "Open files & changes", gitDialog: "Files and changes", lifecycleTitle: "Windows local terminal", lifecycleHint: "Create a Shell terminal only after choosing a local directory.", cwd: "Working directory", choosing: "Choosing…", chooseFolder: "Choose folder", folderChosen: "Working directory selected.", target: "Open target", workspace: "Workspace", window: "Separate window", mode: "Launch mode", background: "Background", focused: "Focused", create: "Create terminal", creating: "Creating…", shellTitle: "Local terminal", createdFocused: "Terminal created and focused.", createdBackground: "Terminal created in the background.", runList: "Terminals created here", noRuns: "No terminals have been created here.", show: "Show", showing: "Showing…", shown: "Terminal shown.", end: "End", ending: "Ending…", ended: "Terminal ended.", force: "Force", forcing: "Forcing…", forced: "Terminal stopped.", active: "Running", finished: "Ended", accounts: "Provider accounts", forceTitle: "Force stop terminal?", forceBody: "This immediately stops this terminal. Unsaved command-line work may be lost.", cancel: "Cancel", cwdRequired: "Choose a local working directory.", projectRequired: "Choose a registered project first.", cwdUnknown: "Working directory unavailable.", failed: "This action could not be completed." };
const cn: Copy = { title: "外部工具连接", toolsHint: "资源管理器和本地 Git 使用选中的项目；终端只会在你选择的本地目录中创建。", explorerTitle: "资源管理器", explorerHint: "在资源管理器中打开选中的已登记项目。", opening: "正在打开…", openExplorer: "打开资源管理器", explorerOpened: "已打开资源管理器。", project: "已登记项目", selectProject: "选择已登记项目", gitTitle: "内建 Git", gitHint: "检查选中的项目，然后打开本地文件和更改。", checking: "正在检查…", openGit: "打开文件与更改", gitDialog: "文件与更改", lifecycleTitle: "Windows 本地终端", lifecycleHint: "选择本地目录后才会创建 Shell 终端。", cwd: "工作目录", choosing: "正在选择…", chooseFolder: "选择目录", folderChosen: "已选择工作目录。", target: "打开位置", workspace: "工作区", window: "独立窗口", mode: "启动方式", background: "后台", focused: "前台并聚焦", create: "创建终端", creating: "正在创建…", shellTitle: "本地终端", createdFocused: "已创建并聚焦终端。", createdBackground: "已在后台创建终端。", runList: "此处创建的终端", noRuns: "尚未在此处创建终端。", show: "显示", showing: "正在显示…", shown: "已显示终端。", end: "结束", ending: "正在结束…", ended: "终端已结束。", force: "强制", forcing: "正在强制结束…", forced: "终端已停止。", active: "运行中", finished: "已结束", accounts: "提供商账户", forceTitle: "强制结束终端？", forceBody: "这会立即停止该终端，未保存的命令行工作可能丢失。", cancel: "取消", cwdRequired: "请选择本地工作目录。", projectRequired: "请先选择已登记项目。", cwdUnknown: "工作目录不可用。", failed: "无法完成此操作。" };
function errorMessage(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
