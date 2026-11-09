import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, Session, SessionProcess, SessionProcessList, Settings } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { formatMemory, releaseReasonLabel, runningSummary, stopIdleLabel } from "../sessionRelease";
import { Icon, SessionIcon } from "./PrototypeIcon";
import "./running-agents.css";

type ViewProps = {
  processes?: SessionProcessList;
  sessions: readonly Session[];
  projects: readonly Project[];
  zh: boolean;
  idleMinutes: number;
  busy?: boolean;
  issue?: string;
  onStopIdle: () => void;
  onStop: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onIdleMinutes: (minutes: number) => void;
};

const IDLE_OPTIONS = [0, 15, 30, 60, 120];

const basename = (path: string | undefined) => {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
};

function stateLabel(row: SessionProcess, session: Session | undefined, zh: boolean): string {
  if (row.visible) return zh ? "在视图中" : "In view";
  if (row.blocked) {
    const waiting = session?.status === "waiting"
      || session?.activity?.state === "awaiting_approval"
      || session?.activity?.state === "awaiting_parent";
    if (row.blocked === "the session is working or waiting for your answer") {
      return waiting ? (zh ? "等待你处理" : "Waiting for you") : (zh ? "工作中" : "Working");
    }
    return releaseReasonLabel(row.blocked, zh).short;
  }
  if (row.busy) return zh ? "工作中" : "Working";
  if (row.idle) {
    const minutes = Math.max(1, Math.round((row.idleSeconds ?? 0) / 60));
    return zh ? `空闲 ${minutes} 分钟` : `Idle ${minutes} min`;
  }
  return zh ? "空闲" : "Idle";
}

/** Presentational Running agents section; SettingsData supplies the data. */
export function RunningAgentsView({
  processes, sessions, projects, zh, idleMinutes, busy, issue, onStopIdle, onStop, onOpen, onIdleMinutes,
}: ViewProps) {
  const text = (en: string, cn: string) => (zh ? cn : en);
  const rows = processes?.sessions ?? [];
  const idleRows = rows.filter(row => row.idle);
  const idleMemory = idleRows.reduce((sum, row) => sum + (row.memoryBytes ?? 0), 0);
  const hasMemory = processes?.memoryBytes !== undefined;
  const values = IDLE_OPTIONS.includes(idleMinutes) ? IDLE_OPTIONS : [...IDLE_OPTIONS, idleMinutes].sort((a, b) => a - b);
  return <div className="running-agents">
    <div className="running-agents-head">
      <div>
        <h4>{text("Running agents", "运行中的智能体")}</h4>
        <p className="running-agents-summary">
          <span>{rows.length > 0 ? runningSummary(rows.length, processes?.memoryBytes, zh) : text("No agent processes are running.", "没有运行中的智能体进程。")}</span>
          {idleRows.length > 0 && <button type="button" className="btn btn-sm running-agents-stop" disabled={busy} onClick={onStopIdle}>
            <Icon name="close" />{stopIdleLabel(idleRows.length, hasMemory ? idleMemory : undefined, zh)}
          </button>}
        </p>
      </div>
      <label className="running-agents-setting">{text("Release idle sessions after", "空闲会话释放时间")}
        <select value={idleMinutes} disabled={busy} onChange={event => onIdleMinutes(Number(event.target.value))}>
          {values.map(value => <option key={value} value={value}>
            {value === 0 ? text("Off", "关闭") : value < 60 ? text(`${value} min`, `${value} 分钟`) : text(`${value / 60} h`, `${value / 60} 小时`)}
          </option>)}
        </select>
      </label>
    </div>
    {rows.length > 0 && <ul className="running-agents-rows">
      {rows.map(row => {
        const session = sessions.find(candidate => candidate.id === row.sessionId);
        const project = projects.find(candidate => candidate.id === session?.projectId);
        const branch = basename(session?.worktreePath);
        const title = session?.title ?? row.sessionId;
        return <li key={row.sessionId} className="running-agents-row" data-blocked={row.blocked ? "true" : undefined}>
          {session ? <SessionIcon session={session} /> : <Icon name="terminal" />}
          <button type="button" className="running-agents-title" onClick={() => onOpen(row.sessionId)}>{title}</button>
          <span className="running-agents-place">{[project?.name, branch].filter(Boolean).join(" · ")}</span>
          <span className={`running-agents-state${row.idle ? " is-idle" : ""}${row.blocked ? " is-busy" : ""}`}>{stateLabel(row, session, zh)}</span>
          <span className="running-agents-memory">{hasMemory ? formatMemory(row.memoryBytes) : ""}</span>
          <button type="button" className="btn btn-sm running-agents-row-stop" disabled={busy || Boolean(row.blocked)} title={row.blocked ? releaseReasonLabel(row.blocked, zh).full : text("Stop (release resources)", "停止（释放资源）")} aria-label={`${text("Stop", "停止")} ${title}`} onClick={() => onStop(row.sessionId)}>{text("Stop", "停止")}</button>
        </li>;
      })}
    </ul>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </div>;
}

/** Loads on demand every five seconds while Settings → Data is shown. */
export function RunningAgents({
  settings, zh, active, sessions, projects, onSaved, onOpen,
}: {
  settings: Settings;
  zh: boolean;
  active: boolean;
  sessions: readonly Session[];
  projects: readonly Project[];
  onSaved: () => Promise<void>;
  onOpen: (sessionId: string) => void;
}) {
  const [processes, setProcesses] = useState<SessionProcessList>();
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const revision = useRef(settings.revision);
  useEffect(() => { revision.current = settings.revision; }, [settings.revision]);
  const load = useCallback(async () => {
    try {
      setProcesses(await request("session.processes", {}));
      setIssue(undefined);
    } catch (caught) {
      setIssue(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const tick = () => {
      void request("session.processes", {}).then(next => { if (live) setProcesses(next); }).catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [active]);
  const idleMinutes = Number(settings["sessions.idleReleaseMinutes"] ?? 30);
  const updateIdle = async (minutes: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await request("settings.update", {
        patch: { "sessions.idleReleaseMinutes": minutes },
        expectedRevision: revision.current,
        operationId: operationId(),
      });
      revision.current = next.revision;
      await onSaved();
      await load();
    } catch (caught) {
      setIssue(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const stop = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await onSaved();
      await load();
    } catch (caught) {
      setIssue(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return <RunningAgentsView
    processes={processes}
    sessions={sessions}
    projects={projects}
    zh={zh}
    idleMinutes={idleMinutes}
    busy={busy}
    issue={issue}
    onStopIdle={() => void stop(() => request("session.releaseIdle", { operationId: operationId() }))}
    onStop={sessionId => void stop(() => request("session.releaseResources", { sessionId, operationId: operationId() }))}
    onOpen={onOpen}
    onIdleMinutes={minutes => void updateIdle(minutes)}
  />;
}
