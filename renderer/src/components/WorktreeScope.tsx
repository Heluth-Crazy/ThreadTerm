import { Select } from "./ui/Select";
import { FormEvent, useEffect, useState } from "react";
import type { LocalBranch, Project, Worktree } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { displayPath, sameCanonicalScope } from "../projectScope";
import { workbenchError } from "../workbench/errors";
import { useTranslation } from "../i18n";

type Props = { project: Project; value?: string; onChange: (path?: string) => void };

export function WorktreeScope(props: Props) {
  return <ProjectWorktreeScope key={props.project.id} {...props} />;
}

function ProjectWorktreeScope({
  project,
  value,
  onChange,
}: {
  project: Project;
  value?: string;
  onChange: (path?: string) => void;
}) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  const [items, setItems] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<LocalBranch[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [relocating, setRelocating] = useState<Worktree>();
  const [relocationPath, setRelocationPath] = useState("");
  const [branchIssue, setBranchIssue] = useState<string>();
  const reload = () => Promise.all([
    request("worktree.list", { projectId: project.id })
      .then((next) => { setItems(next); setIssue(undefined); })
      .catch((error) =>
        setIssue(
          error instanceof Error
            ? error.message
            : "Unable to list registered worktrees.",
        ),
      ),
    request("worktree.branches", { projectId: project.id })
      .then((next) => { setBranches(next); setBranchIssue(undefined); })
      .catch((error) => { setBranches([]); setBranchIssue(workbenchError(error, zh)); }),
  ]);
  useEffect(() => {
    void reload();
  }, [project.id, zh]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setIssue(undefined);
    try {
      const created = await request("worktree.create", {
        projectId: project.id,
        path: path.trim(),
        branch: branch.trim(),
        createBranch: !existing,
        ...(!existing && base ? { startPoint: base } : {}),
        operationId: operationId(),
      });
      await reload();
      onChange(created.path);
      setPath("");
      setBranch("");
    } catch (error) {
      setIssue(
        workbenchError(error, zh),
      );
    } finally {
      setBusy(false);
    }
  };
  const existing = branches.some((item) => item.name === branch.trim());
  const currentWorktree = items.find((item) => value && sameCanonicalScope(item.path, value));
  const base = startPoint || currentWorktree?.head || branches.find((item) => item.current)?.name || "";
  const baseByName = new Map<string, LocalBranch>();
  branches.forEach((item) => { baseByName.set(item.name, item); if (item.upstream) baseByName.set(item.upstream, item); });
  const baseOptions = [...baseByName.entries()].map(([name, item]) => ({ name, item }));
  const baseCommit = branches.find((item) => item.name === base || item.lastCommit.id === base)?.lastCommit;
  const relocate = async (item: Worktree) => {
    const path = relocationPath.trim();
    if (!path) return;
    setBusy(true);
    setIssue(undefined);
    try {
      const moved = await request("worktree.relocate", {
        id: item.id,
        path,
        operationId: operationId(),
      });
      if (value === item.path) onChange(moved.path);
      await reload();
      setRelocating(undefined);
    } catch (error) {
      setIssue(
        error instanceof Error ? error.message : "Unable to relocate worktree.",
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async (item: Worktree) => {
    if (item.isMain || !confirm(`Remove worktree ${displayPath(item.path)}?`)) return;
    setBusy(true);
    setIssue(undefined);
    try {
      await request("worktree.remove", {
        id: item.id,
        operationId: operationId(),
      });
      if (value === item.path) onChange(undefined);
      await reload();
    } catch (error) {
      setIssue(
        error instanceof Error ? error.message : "Unable to remove worktree.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="worktree-scope panel">
      <div className="panel-header">
        <h2>Worktree scope</h2>
        <button onClick={() => void reload()}>Refresh</button>
      </div>
      <label>
        Directory{" "}
        <Select
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">Project root · {displayPath(project.path)}</option>
          {items
            .filter((item) => !item.isMain)
            .map((item) => (
              <option key={item.id} value={item.path} disabled={item.missing}>
                {item.branch ?? "detached"} · {displayPath(item.path)}
                {item.missing ? " (missing)" : ""}
              </option>
            ))}
        </Select>
      </label>
      <div className="worktree-list">
        {items
          .filter((item) => !item.isMain)
          .map((item) => (
            <div key={item.id}>
              <span>{item.branch ?? "detached"}</span>
              <small>{displayPath(item.path)}</small>
              {item.missing && <button
                disabled={busy}
                onClick={() => { setRelocating(item); setRelocationPath(item.path); }}
              >
                Locate missing worktree
              </button>}
              <button
                disabled={busy || item.locked || item.missing}
                onClick={() => void remove(item)}
              >
                Remove
              </button>
            </div>
          ))}
      </div>
      {relocating && <form onSubmit={(event) => { event.preventDefault(); void relocate(relocating); }}>
        <label>Existing worktree path<input required value={relocationPath} onChange={(event) => setRelocationPath(event.target.value)} /></label>
        <p>Reconnect this worktree to its existing directory. Active sessions must be stopped first.</p>
        <button type="submit" disabled={busy}>Locate worktree</button>
        <button type="button" disabled={busy} onClick={() => setRelocating(undefined)}>Cancel</button>
      </form>}
      <section aria-label="Local branches">
        <h3>Local branches ({branches.length})</h3>
        {branchIssue && <p role="status">Git branches unavailable: {branchIssue}. You can still use the project directory for sessions and files.</p>}
        {(expanded ? branches : branches.slice(0, 8)).map((item) => (
          <div key={item.name}>
            <button type="button" disabled={busy} onClick={() => {
              setBranch(item.name);
            }}>
              {item.current ? "✓ " : ""}{item.name}
            </button>
            <small>{item.upstream ?? "No upstream"} · {item.lastCommit.id.slice(0, 8)} · {item.lastCommit.subject}</small>
          </div>
        ))}
        {branches.length > 8 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${branches.length} branches`}
        </button>}
      </section>
      <form
        className="worktree-create"
        onSubmit={(event) => void create(event)}
      >
        <label>New absolute worktree path<input
          required
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="New absolute worktree path"
        /></label>
        <label>Branch<input
          required
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="Branch"
        /></label>
        <label>
          {zh ? "基准" : "Base"}
          <Select aria-label={zh ? "基准" : "Base"} value={base} disabled={existing} onChange={(event) => setStartPoint(event.target.value)}>
            {base && !baseOptions.some((option) => option.name === base) && <option value={base}>{baseCommit ? `${baseCommit.id.slice(0, 8)} · ${baseCommit.subject}` : base}</option>}
            {baseOptions.map((option) => <option key={option.name} value={option.name}>{option.name}</option>)}
          </Select>
        </label>
        {existing ? <p>{zh ? "使用已有分支。已有分支保留其现有提交，不能选择基准。" : "Use existing branch. An existing branch keeps its current commit, so its base cannot be changed."}</p> : baseCommit && <p>{baseCommit.id.slice(0, 8)} · {baseCommit.subject}</p>}
        <button disabled={busy || Boolean(branchIssue)} type="submit">
          Create worktree
        </button>
      </form>
      {issue && (
        <p role="alert" className="surface-error">
          {issue}
        </p>
      )}
    </section>
  );
}
