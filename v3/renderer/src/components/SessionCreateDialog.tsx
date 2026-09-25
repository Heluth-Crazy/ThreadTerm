import { Select } from "./ui/Select";
import { useEffect, useId, useMemo, useState } from "react";
import type { ProviderId, Session, Snapshot, Worktree } from "@threadterm/protocol";
import { chooseDirectory, operationId, request } from "../bridge";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { SurfaceDialog } from "./SurfaceDialog";
import { useTranslation } from "../i18n";
import "./session-create-dialog.css";
import { sessionStartup } from "../sessionStartup";
import { closestProjectForPath, displayPath } from "../projectScope";

type Props = { data: Snapshot; onClose: () => void; onCreated: (session: Session) => void; initialProjectId?: string; initialPath?: string; initialProvider?:ProviderId; initialTitle?:string };
const providers: ProviderId[] = ["codex", "claude", "kimi", "gemini", "opencode", "grok", "shell", "custom"];
const providerName = (id: ProviderId) => id === "claude" ? "Claude" : id === "opencode" ? "OpenCode" : id[0].toUpperCase() + id.slice(1);

export function SessionCreateDialog({ data, onClose, onCreated, initialProjectId, initialPath, initialProvider, initialTitle }: Props) {
  const { locale } = useTranslation(); const zh = locale === "zh-CN"; const tx = (en: string, cn: string) => zh ? cn : en;
  const initialCwd = initialPath ?? data.projects.find((project) => project.id === initialProjectId)?.path ?? data.projects[0]?.path ?? "";
  const [projectId, setProjectId] = useState(closestProjectForPath(data.projects, initialCwd)?.id ?? initialProjectId ?? data.projects[0]?.id ?? "");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [cwd, setCwd] = useState(initialCwd);
  const [title, setTitle] = useState(initialTitle??"");
  const formId=useId();
  const [oneShot,setOneShot]=useState(false);
  const [preset,setPreset]=useState("npm run dev");
  const [provider, setProvider] = useState<ProviderId>(initialProvider??(data.providers.some(p=>p.id==="codex"&&p.installed)?"codex":"shell"));
  const [mode, setMode] = useState<"terminal" | "chat">("terminal");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false); const [issue, setIssue] = useState<string>();
  const selectedProject = data.projects.find((project) => project.id === projectId);
  const capability = data.providers.find((item) => item.id === provider);
  const canCreate = (mode === "terminal" && ["shell", "custom"].includes(provider)) || Boolean(capability?.installed && capability[mode]);
  useEffect(() => { if (!projectId) { setWorktrees([]); return; } let active = true; void request("worktree.list", { projectId }).then((items) => { if (active) setWorktrees(items); }).catch((error) => { if (active) setIssue(error instanceof Error ? error.message : tx("Unable to load worktrees.", "无法读取工作树。")); }); return () => { active = false; }; }, [projectId]);
  const recentProjects = useMemo(() => data.projects.slice(0, 6), [data.projects]);
  const selectProject = (id: string) => { setProjectId(id); const project = data.projects.find((item) => item.id === id); if (project) setCwd(project.path); };
  const applyCwd = (path: string) => { setCwd(path); const owner = closestProjectForPath(data.projects, path); if (owner) setProjectId(owner.id); };
  const selectWorktree = (path: string) => applyCwd(path || (selectedProject?.path ?? ""));
  const createIssue = (error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error:\s*)?/i, "").trim();
    if (message.includes("selected_project_mismatch")) return tx("The working directory belongs to a different registered project. Choose that project, or pick a directory inside the selected one.", "工作目录属于另一个已登记项目。请改选该项目，或选择当前项目内的目录。");
    if (message.includes("cwd_not_in_registered_project")) return tx("The working directory is not inside the selected project.", "工作目录不在所选项目内。");
    if (message.includes("invalid_cwd") || message.includes("cwd must be")) return tx("Choose an existing local folder.", "请选择一个存在的本地文件夹。");
    return message || tx("Session was not created.", "会话未创建。");
  };
  const create = async () => { if (busy) return; const startup=provider==="custom"&&preset!=="custom"?preset:command; const launch=mode === "terminal" ? sessionStartup(startup,oneShot,window.threadterm.platform) : {}; if(mode==="terminal"&&(oneShot||(provider==="custom"&&preset==="custom"))&&!startup.trim()){setIssue(tx("Enter a command to run.","请输入要运行的命令。"));return;} if (!cwd.trim()) { setIssue(tx("Choose a local working directory.", "请选择本地工作目录。")); return; } if (!canCreate) { setIssue(capability?.reason ?? tx("This provider cannot create the selected type.", "该提供者无法创建所选类型。")); return; } setBusy(true); setIssue(undefined); try { const owner = closestProjectForPath(data.projects, cwd.trim()); const session = await request("session.create", { cwd: cwd.trim(), projectId: owner?.id ?? (projectId || undefined), title: title.trim() || undefined, provider, mode, ...launch, ...(provider === "codex" && mode === "terminal" && !launch.executable ? { deferLaunch: true } : {}), operationId: operationId() }); onCreated(session); } catch (error) { setIssue(createIssue(error)); } finally { setBusy(false); } };
  return <SurfaceDialog title={tx("New terminal", "新建终端")} icon="terminal" onClose={onClose} variant="create" footer={<><button className="btn" onClick={onClose}>{tx("Cancel", "取消")}</button><button className="btn btn-primary" disabled={busy || !canCreate} type="submit" form={formId}>{busy ? tx("Creating…", "正在创建…") : tx("Create", "创建")}</button></>}>
    <form id={formId} className="create-form" onSubmit={event=>{event.preventDefault();void create();}}>
      <label className="create-block"><span className="create-label">{tx("Recent projects", "最近项目")}</span><div className="create-chips">{recentProjects.map((project) => <button type="button" key={project.id} className={project.id === projectId ? "create-chip is-on" : "create-chip"} onClick={() => selectProject(project.id)}><Icon name="folder" /><span>{project.name}</span></button>)}</div></label>
      <label className="create-block"><span className="create-label">{tx("Name", "名称")}</span><input className="create-input" placeholder={tx("Development session","开发会话")} maxLength={60} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label>
      <label className="create-block"><span className="create-label">{tx("Project", "项目")}</span><Select className="create-input" value={projectId} onChange={(event) => selectProject(event.target.value)}><option value="">{tx("No project", "无项目")}</option>{data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></label>
      <label className="create-block"><span className="create-label">{tx("Working directory", "工作目录")}</span><div className="create-path-row"><Select className="create-input create-input-mono" value={cwd} onChange={(event) => selectWorktree(event.target.value)}>{!worktrees.some(t=>t.path===selectedProject?.path)&&<option value={selectedProject?.path ?? ""}>{tx("Project root", "项目根目录")} · {displayPath(selectedProject?.path) || tx("Choose a project", "选择项目")}</option>}{cwd!==selectedProject?.path&&!worktrees.some(t=>t.path===cwd)&&<option value={cwd}>{displayPath(cwd)}</option>}{worktrees.filter((tree) => !tree.missing).map((tree) => <option key={tree.id} value={tree.path}>{tree.branch ?? tx("Detached", "分离状态")} · {displayPath(tree.path)}</option>)}</Select><button type="button" className="create-browse" onClick={() => void chooseDirectory().then((path) => path && applyCwd(path))}><Icon name="folder" />{tx("Browse", "浏览")}</button></div><input className="create-input create-input-mono" value={displayPath(cwd)} onChange={(event) => applyCwd(event.target.value)} aria-label={tx("Local path", "本地路径")} /></label>
      <fieldset className="create-block"><legend className="create-label">{tx("Type", "类型")}</legend><div className="create-type-grid">{providers.map((id) => { const available = id === "shell" || id === "custom" || data.providers.find((item) => item.id === id)?.installed; return <button type="button" key={id} disabled={!available} className={provider === id ? "create-type is-on" : "create-type"} onClick={() => { setProvider(id); if (!data.providers.find((item) => item.id === id)?.chat) setMode("terminal"); }}><AgentIcon provider={id} size={16} /><span>{id==="custom"?tx("Preset","预设"):providerName(id)}</span></button>; })}</div></fieldset>
      <fieldset className="create-block"><legend className="create-label">{tx("Create as", "创建方式")}</legend><div className="create-choice-grid">{(["terminal", "chat"] as const).map((value) => <button type="button" key={value} disabled={value === "chat" && !capability?.chat} className={mode === value ? "create-choice is-on" : "create-choice"} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === "terminal" ? "Terminal" : "Chat"}</button>)}</div></fieldset>
      {provider === "custom" && <label className="create-block"><span className="create-label">{tx("Command preset","命令预设")}</span><Select className="create-input" value={preset} onChange={event=>setPreset(event.target.value)}>{["npm run dev","yarn dev","pnpm dev","docker compose up","python -m http.server","node server.js"].map(value=><option key={value}>{value}</option>)}<option value="custom">{tx("Custom","自定义")}</option></Select></label>}
      {mode === "terminal" && <><label className="create-block"><span className="create-label">{tx("Initial command", "初始命令")} <span className="create-optional">{tx("Optional","可选")}</span></span><input className="create-input create-input-mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npm run dev" disabled={provider==="custom"&&preset!=="custom"} /><p className="create-hint">{tx("Leave blank for the default command. Runs when you choose Create.", "留空使用该类型的默认命令；点击创建后运行。")}</p></label><div className="create-block"><span className="create-label">{tx("Execution","执行方式")}</span><div className="create-choice-grid"><label className="create-choice"><input type="radio" checked={!oneShot} onChange={()=>setOneShot(false)}/>{tx("Interactive session","交互会话")}</label><label className="create-choice"><input type="radio" checked={oneShot} onChange={()=>setOneShot(true)}/>{tx("Run once","一次性运行")}</label></div></div></>}
      {issue && <p className="surface-error" role="alert">{issue}</p>}
    </form>
  </SurfaceDialog>;
}
