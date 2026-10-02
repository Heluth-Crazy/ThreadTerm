import { useCallback, useEffect, useMemo, useState } from "react";
import type { LocalBranch, Project, Worktree } from "@threadterm/protocol";
import { chooseDirectory, operationId, request } from "../bridge";
import { displayPath } from "../projectScope";
import { SurfaceDialog } from "./SurfaceDialog";
import { Icon } from "./PrototypeIcon";
import "./worktree-manager.css";

type Props = {
  project: Project;
  initialWorktreeId?: string;
  onClose: () => void;
  onChanged: () => void;
  onSelected?: (path?: string) => void;
};

export function WorktreeManager({ project, initialWorktreeId, onClose, onChanged, onSelected }: Props) {
  const zh = document.documentElement.lang === "zh-CN";
  const copy = (en: string, cn: string) => zh ? cn : en;
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<LocalBranch[]>([]);
  const [selectedId, setSelectedId] = useState(initialWorktreeId);
  const [relocationPath, setRelocationPath] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<Worktree>();
  const [showBranches, setShowBranches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const reload = useCallback(async () => {
    setIssue(undefined);
    const [treesResult, branchesResult] = await Promise.allSettled([
      request("worktree.list", { projectId: project.id }),
      request("worktree.branches", { projectId: project.id }),
    ]);
    if (treesResult.status === "rejected") {
      setWorktrees([]); setBranches([]);
      setIssue(treesResult.reason instanceof Error ? treesResult.reason.message : copy("Unable to load worktrees.", "无法读取工作树。"));
      return;
    }
    const trees = treesResult.value;
    setWorktrees(trees);
    if (branchesResult.status === "fulfilled") setBranches(branchesResult.value);
    else {
      setBranches([]);
      setIssue(branchesResult.reason instanceof Error ? branchesResult.reason.message : copy("Worktrees are available, but local branches could not be read.", "工作树可用，但无法读取本地分支。"));
    }
    setSelectedId((current) => current && trees.some((tree) => tree.id === current) ? current : trees.find((tree) => tree.isMain)?.id ?? trees[0]?.id);
  }, [project.id]);
  useEffect(() => { void reload(); }, [reload]);
  const selected = useMemo(() => worktrees.find((tree) => tree.id === selectedId), [worktrees, selectedId]);
  const relocate = async () => {
    if (!selected || !relocationPath.trim()) return;
    setBusy(true); setIssue(undefined);
    try {
      const moved = await request("worktree.relocate", { id: selected.id, path: relocationPath.trim(), operationId: operationId() });
      onSelected?.(moved.path); await reload(); onChanged(); setRelocationPath("");
    } catch (error) { setIssue(error instanceof Error ? error.message : copy("Unable to relocate this worktree.", "无法重新定位此工作树。")); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirmRemove) return;
    setBusy(true); setIssue(undefined);
    try {
      await request("worktree.remove", { id: confirmRemove.id, operationId: operationId() });
      if (selectedId === confirmRemove.id) onSelected?.();
      setConfirmRemove(undefined); await reload(); onChanged();
    } catch (error) { setIssue(error instanceof Error ? error.message : copy("Unable to remove this worktree.", "无法移除此工作树。")); }
    finally { setBusy(false); }
  };
  return <SurfaceDialog title={copy("Manage worktrees", "管理工作树")} subtitle={project.name} icon="branch" onClose={onClose} size="wide" footer={<><button className="btn" onClick={onClose}>{copy("Close", "关闭")}</button></>}>
    <div className="worktree-manager">
      <aside className="wtm-list" aria-label={copy("Project worktrees", "项目工作树")}><header><strong>{copy("Worktrees", "工作树")}</strong><button className="icon-btn" onClick={() => void reload()} aria-label={copy("Refresh worktrees", "刷新工作树")}><Icon name="refresh" /></button></header>
        {worktrees.map((tree) => <button key={tree.id} className={tree.id === selectedId ? "wtm-row active" : "wtm-row"} onClick={() => { setSelectedId(tree.id); setRelocationPath(tree.path); }}><Icon name="branch" /><span><b>{tree.isMain ? copy("Project root", "项目根目录") : tree.branch ?? copy("Detached worktree", "分离工作树")}</b><small>{displayPath(tree.path)}</small></span>{tree.missing && <em>{copy("Missing", "目录缺失")}</em>}</button>)}
      </aside>
      <section className="wtm-detail" aria-live="polite">{selected ? <><header><div><h3>{selected.isMain ? copy("Project root", "项目根目录") : selected.branch ?? copy("Detached worktree", "分离工作树")}</h3><p>{displayPath(selected.path)}</p></div>{selected.missing ? <span className="chip st-needs">{copy("Missing", "目录缺失")}</span> : <span className="chip st-running">{copy("Available", "可用")}</span>}</header>
        <dl><dt>{copy("Branch", "分支")}</dt><dd>{selected.branch ?? copy("Detached", "分离状态")}</dd><dt>{copy("State", "状态")}</dt><dd>{selected.isMain ? copy("Main worktree", "主工作树") : selected.locked ? copy("Locked", "已锁定") : copy("Registered", "已注册")}</dd></dl>
        {selected.missing && <section className="wtm-relocate"><h4>{copy("Relocate missing worktree", "重新定位缺失工作树")}</h4><p>{copy("Choose the existing directory. It is checked before reconnecting; no files are moved.", "选择现有目录。重新连接前会检查目录，不会移动文件。")}</p><label>{copy("Existing absolute path", "现有绝对路径")}<div className="wtm-path-picker"><input value={relocationPath} onChange={(event) => setRelocationPath(event.target.value)} placeholder={displayPath(selected.path)} /><button className="btn" disabled={busy} onClick={() => void chooseDirectory().then((path) => { if (path) setRelocationPath(path); }).catch((error) => setIssue(error instanceof Error ? error.message : copy("Unable to choose a directory.", "无法选择目录。")))}>{copy("Choose folder", "选择文件夹")}</button></div></label><button className="btn btn-primary" disabled={busy || !relocationPath.trim()} onClick={() => void relocate()}>{copy("Relocate worktree", "重新定位工作树")}</button></section>}
        {!selected.isMain && <button className="btn btn-danger" disabled={busy || selected.locked || selected.missing} onClick={() => setConfirmRemove(selected)}>{copy("Remove worktree", "移除工作树")}</button>}
      </> : <p>{copy("No registered worktrees.", "没有已注册的工作树。")}</p>}
        <section className="wtm-branches"><button className="btn-subtle" aria-expanded={showBranches} onClick={() => setShowBranches((value) => !value)}>{copy(`Local branches (${branches.length})`, `本地分支（${branches.length}）`)}</button>{showBranches && <div>{branches.map((branch) => <div key={branch.name}><b>{branch.current ? "✓ " : ""}{branch.name}</b><small>{branch.upstream ?? copy("No upstream", "无上游")} · {branch.lastCommit.id.slice(0, 8)} · {branch.lastCommit.subject}</small></div>)}</div>}</section>
        {issue && <p className="surface-error" role="alert">{issue}</p>}
      </section>
    </div>
    {confirmRemove && <SurfaceDialog title={copy("Remove worktree?", "移除工作树？")} subtitle={displayPath(confirmRemove.path)} icon="branch" onClose={() => setConfirmRemove(undefined)} size="sm" footer={<><button className="btn" onClick={() => setConfirmRemove(undefined)}>{copy("Cancel", "取消")}</button><button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{copy("Remove", "移除")}</button></>}><p className="wtm-confirm">{copy("Removal preserves its session history. It may be refused when this is the main worktree, is locked, has active sessions, or needs protection.", "移除后会保留会话历史。主工作树、已锁定的工作树、有活动会话或受保护的工作树可能无法移除。")}</p></SurfaceDialog>}
  </SurfaceDialog>;
}
