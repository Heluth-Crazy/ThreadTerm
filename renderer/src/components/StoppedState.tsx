import "./stopped-state.css";

/**
 * The one compact "Stopped — Continue" row a released chat or terminal shows.
 * It is a view of the persisted state only: the parent resumes on the click.
 * A failed explicit resume leaves Continue enabled and says why; when the
 * working folder is gone it offers the relocation the runtime asks for.
 */
export function StoppedState({ zh, busy, issue, onContinue, onRelocate }: {
  zh: boolean; busy?: boolean;
  issue?: { message: string; needsFolder?: boolean };
  onContinue: () => void;
  onRelocate?: () => void;
}) {
  return <span className="chat-stopped" role="status">
    <strong>{zh ? "已停止" : "Stopped"}</strong>
    <span aria-hidden="true">—</span>
    <button type="button" className="chip chip-btn chat-stopped-continue" disabled={Boolean(busy)} onClick={onContinue}>
      {busy ? (zh ? "正在连接…" : "Connecting…") : (zh ? "继续" : "Continue")}
    </button>
    {issue && <span className="chat-stopped-issue" data-stopped-issue="">
      <span>{issue.message}</span>
      {issue.needsFolder && onRelocate && <button type="button" className="chip chip-btn chat-stopped-relocate" disabled={Boolean(busy)} onClick={onRelocate}>
        {zh ? "选择文件夹" : "Choose folder"}
      </button>}
    </span>}
  </span>;
}
