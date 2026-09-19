import { type ReactNode, useRef, useState } from "react";
import type { ContentRef, PaneLayout, Session } from "@threadterm/protocol";
import { confirmCloseEditors } from "../dirtyEditors";
import { useTranslation } from "../i18n";
import {
  splitPane,
  closePane,
  activate,
  closeTab,
  reorderTab,
  resizeSplit,
} from "../workspaceLayout";
import { operationId, request } from "../bridge";
import { TerminalSurface } from "./TerminalSurface";
import { ChatView } from "./ChatView";
import { FileWorkspace } from "./FileWorkspace";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { ImportedHistoryView } from "./ImportedHistoryView";
import "./workspace-parity.css";

type Props = {
  layout: PaneLayout;
  sessions: Session[];
  theme: "light" | "dark";
  terminalCompatibility: unknown;
  onChange: (next: PaneLayout) => void;
  onSessionChanged?: () => void;
  ownerSessionId?: string;
};
export function PaneWorkspace({ layout, sessions, onChange, theme, terminalCompatibility, onSessionChanged, ownerSessionId }: Props) {
  const [selectedPaneId, setSelectedPaneId] = useState<string>();
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string>();
  const [resumedSessionIds, setResumedSessionIds] = useState<Set<string>>(() => new Set());
  const render = (node: PaneLayout): ReactNode =>
    node.kind === "split" ? (
      <Split node={node} root={layout} render={render} onChange={onChange} />
    ) : (
      <Pane
        node={node}
        sessions={sessions}
        theme={theme}
        terminalCompatibility={terminalCompatibility}
        onChange={onChange}
        layout={layout}
        selected={selectedPaneId === node.id}
        fullscreen={fullscreenPaneId === node.id}
        onFocus={() => setSelectedPaneId(node.id)}
        onToggleFullscreen={() => setFullscreenPaneId(current => current === node.id ? undefined : node.id)}
        onSessionChanged={onSessionChanged}
        ownerSessionId={ownerSessionId}
        resumedSessionIds={resumedSessionIds}
        onResumed={(sessionId) => setResumedSessionIds(current => new Set(current).add(sessionId))}
      />
    );
  return (
    <section className={`pane-workspace ws-content ${fullscreenPaneId ? "pane-focused" : ""}`} aria-label="Workspace panes">
      {render(layout)}
    </section>
  );
}
function Split({
  node,
  root,
  render,
  onChange,
}: {
  node: Extract<PaneLayout, { kind: "split" }>;
  root: PaneLayout;
  render: (node: PaneLayout) => ReactNode;
  onChange: (next: PaneLayout) => void;
}) {
  const grabOffset = useRef<number | null>(null);
  const drag = (event: React.PointerEvent) => {
    const container = event.currentTarget.parentElement;
    if (!container || grabOffset.current === null) return;
    const box = container.getBoundingClientRect();
    const divider = event.currentTarget.getBoundingClientRect();
    const vertical = node.direction === "vertical";
    const gap = Number.parseFloat(getComputedStyle(container)[vertical ? "rowGap" : "columnGap"]) || 0;
    const dividerSize = vertical ? divider.height : divider.width;
    const available = (vertical ? box.height : box.width) - 2 * gap - dividerSize;
    if (available <= 0) return;
    const position = vertical ? event.clientY - box.top : event.clientX - box.left;
    const ratio = (position - grabOffset.current - gap - dividerSize / 2) / available;
    onChange(resizeSplit(root, node.id, ratio));
  };
  return (
    <div
      className={`pane-split ${node.direction}`}
      data-split-id={node.id}
    >
      <div className="pane-split-child" style={{ flex: `${node.ratio} 1 0px` }}>{render(node.first)}</div>
      <div
        className="pane-divider"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const divider = event.currentTarget.getBoundingClientRect();
          grabOffset.current = node.direction === "vertical"
            ? event.clientY - divider.top - divider.height / 2
            : event.clientX - divider.left - divider.width / 2;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) =>
          event.currentTarget.hasPointerCapture(event.pointerId) && drag(event)
        }
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          grabOffset.current = null;
        }}
        onPointerCancel={() => { grabOffset.current = null; }}
        onLostPointerCapture={() => { grabOffset.current = null; }}
      />
      <div className="pane-split-child" style={{ flex: `${1 - node.ratio} 1 0px` }}>{render(node.second)}</div>
    </div>
  );
}
function editorId(paneId: string, tab: ContentRef) {
  return `workspace:${paneId}:${tab.id}`;
}
function Pane({
  node,
  sessions,
  theme,
  terminalCompatibility,
  onChange,
  layout,
  selected,
  fullscreen,
  onFocus,
  onToggleFullscreen,
  onSessionChanged,
  resumedSessionIds,
  onResumed,
  ownerSessionId,
}: {
  node: Extract<PaneLayout, { kind: "pane" }>;
  sessions: Session[];
  theme: "light" | "dark";
  terminalCompatibility: unknown;
  onChange: (next: PaneLayout) => void;
  layout: PaneLayout;
  selected: boolean;
  fullscreen: boolean;
  onFocus: () => void;
  onToggleFullscreen: () => void;
  onSessionChanged?: () => void;
  resumedSessionIds: Set<string>;
  onResumed: (sessionId: string) => void;
  ownerSessionId?: string;
}) {
  const {locale}=useTranslation();const zh=locale==="zh-CN";
  const tab =
    node.tabs.find((item) => item.id === node.activeTabId) ?? node.tabs[0];
  const [issue, setIssue] = useState<string>();
  const session =
    tab?.kind === "session"
      ? sessions.find((item) => item.id === tab.sessionId)
      : undefined;
  const close = (mode: "current" | "others" | "all") => {
    const targets =
      mode === "current"
        ? [tab].filter(Boolean)
        : mode === "others"
          ? node.tabs.filter((item) => item.id !== tab?.id)
          : node.tabs;
    const editors = targets
      .filter(
        (item): item is ContentRef => Boolean(item) && item.kind !== "session",
      )
      .map((item) => editorId(node.id, item));
    void confirmCloseEditors(editors).then((ok) => {
      if (!ok) return;
      let next = layout;
      for (const item of targets)
        if (item) next = closeTab(next, node.id, item.id);
      onChange(next);
    });
  };
  const content = session?.readOnly && !resumedSessionIds.has(session.id) ? (
    <ImportedHistoryView session={session} onResumed={() => onResumed(session.id)} />
  ) : session ? (
    session.mode === "terminal" ? (
      <TerminalSurface sessionId={session.id} provider={session.provider} session={session} theme={theme} terminalCompatibility={terminalCompatibility} onChanged={onSessionChanged} />
    ) : (
      <ChatView session={session} />
    )
  ) : tab?.kind !== "session" && tab ? (
    <FileWorkspace
      key={tab.id}
      projectId={tab.projectId}
      worktreePath={tab.worktreePath}
      initialPath={tab.path}
      initialView={tab.kind}
      editorId={editorId(node.id, tab)}
      ownerSessionId={ownerSessionId}
    />
  ) : null;
  const tabLabel = (item: ContentRef) => item.kind === "session"
    ? sessions.find(candidate => candidate.id === item.sessionId)?.title ?? (zh?"终端":"Terminal")
    : item.path.split(/[\\/]/).at(-1) ?? item.kind;
  return (
    <section data-pane-id={node.id} className={`workspace-pane ws-pane ${fullscreen ? "fullscreen" : ""}${selected ? " selected" : ""}`} onPointerDown={onFocus}>
      <header className="ws-tile-bar">
        <span className="ws-tile-grip" aria-hidden="true"><Icon name="more" /></span>
        {session && <AgentIcon provider={session.provider} />}
        {node.tabs.map((item, index) => (
          <button
            className={`ws-pane-tab ${item.id === tab?.id ? "active" : ""}`}
            draggable
            key={item.id}
            onDragStart={(event) =>
              event.dataTransfer.setData("tab-index", String(index))
            }
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) =>
              onChange(
                reorderTab(
                  layout,
                  node.id,
                  Number(event.dataTransfer.getData("tab-index")),
                  index,
                ),
              )
            }
            onClick={() => onChange(activate(layout, node.id, item.id))}
          >
            <span className="ws-tile-name">{tabLabel(item)}</span>
            {item.id === tab?.id && <span className="ws-tile-current">{zh?"当前":"Current"}</span>}
          </button>
        ))}
        <span className="grow" />
        <button className="icon-btn" title={zh?"全屏窗格":"Fullscreen pane"} aria-label={zh?"全屏窗格":"Fullscreen pane"} aria-pressed={fullscreen} onClick={(event) => { event.stopPropagation(); onToggleFullscreen(); }}>
          <Icon name="panel" />
        </button>
        <button className="icon-btn" title={zh?"拆分窗格":"Split pane"} aria-label={zh?"拆分窗格":"Split pane"} onClick={() => tab && onChange(splitPane(layout, node.id, tab))}>
          <Icon name="split" />
        </button>
        <button className="ws-compact-action" onClick={() => close("others")}>{zh?"关闭其他":"Close others"}</button>
        {session && !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status) && (
          <button className="ws-compact-action danger"
            onClick={() =>
              void request("session.stop", {
                sessionId: session.id,
                operationId: operationId(),
              }).then(() => onSessionChanged?.()).catch((error) =>
                setIssue(
                  error instanceof Error
                    ? error.message
                    : (zh?"无法结束会话，当前视图已保留。":"Unable to end session; this view remains open."),
                ),
              )
            }
          >
            {zh?"结束":"End"}
          </button>
        )}
        <button
          className="icon-btn"
          aria-label={zh?"关闭窗格":"Close pane"}
          title={zh?"关闭窗格":"Close pane"}
          onClick={() => {
            const editors = node.tabs
              .filter((item) => item.kind !== "session")
              .map((item) => editorId(node.id, item));
            void confirmCloseEditors(editors).then((ok) => {
              if (!ok) return;
              const next = closePane(layout, node.id);
              if (next) onChange(next);
            });
          }}
        ><Icon name="close" /></button>
      </header>
      {issue && <p className="surface-error">{issue}</p>}
      <div className="pane-body">{content}</div>
    </section>
  );
}
