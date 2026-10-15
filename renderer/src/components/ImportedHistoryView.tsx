import { useEffect, useId, useRef, useState } from "react";
import type { ChatItem, ChatRepairAvailability, Session } from "@threadterm/protocol";
import { operationId, request, subscribeEvents } from "../bridge";
import { acquireControl } from "../controlLease";
import { useTranslation } from "../i18n";
import { HistoryTranscript } from "./HistoryTranscript";
import { SurfaceDialog } from "./SurfaceDialog";
import { ChatForkButton, ChatForkMenu, ChatForkStatus, useChatFork } from './ChatForkControls';
import { MessageActions } from './MessageActions';
import { replyMarkdown } from '../replyMarkdown';
import { isCompletedForkReply } from '../chatFork';
import "./history-rail.css";
import "./chat-network-notice.css";

type Props = { session: Session; onResumed?: (session: Session) => void; onOpenSession?: (id: string) => void };

/** A durable provider-history projection. It never mounts an interactive host. */
export function ImportedHistoryView({ session, onResumed, onOpenSession }: Props) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  const copy = (en: string, cn: string) => zh ? cn : en;
  const [items, setItems] = useState<ChatItem[]>();
  const [issue, setIssue] = useState<string>();
  const [resuming, setResuming] = useState(false);
  const [repair, setRepair] = useState<ChatRepairAvailability>();
  const [repairDialog, setRepairDialog] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const forkActions = useChatFork(session, repairing || resuming, zh, setIssue);
  const lifecycle = useRef(0);
  const repairDescriptionId = useId();
  useEffect(() => {
    lifecycle.current++;
    setRepairDialog(false); setRepairing(false); setRepair(undefined);
    return () => { lifecycle.current++; };
  }, [session.id]);
  useEffect(() => {
    let current = true;
    setItems(undefined); setIssue(undefined);
    void request("chat.snapshot", { sessionId: session.id })
      .then(result => { if (current) { setItems(result.items); setRepair(result.repair); } })
      .catch(error => { if (current) setIssue(error instanceof Error ? error.message : copy("Saved history could not be read.", "无法读取已保存的历史。")); });
    const unsubscribe = subscribeEvents(event => {
      const data = event.data as { sessionId?: string; kind?: string } | null;
      if (event.event === 'state.changed' && data?.sessionId === session.id && data.kind === 'chat.repair') {
        void request('chat.snapshot', {sessionId: session.id}).then(result => {
          if (current) { setItems(result.items); setRepair(result.repair); }
        }).catch(error => { if (current) setIssue(String(error)); });
      }
    });
    return () => { current = false; unsubscribe(); };
  }, [session.id, locale]);
  const resume = async () => {
    setResuming(true); setIssue(undefined);
    try {
      const resumed = await request("session.resume", { sessionId: session.id, cwd: session.worktreePath, operationId: operationId() });
      if (resumed.id !== session.id || resumed.readOnly) throw new Error(copy('The runtime did not confirm this session was resumed.', '运行时未确认此会话已恢复。'));
      onResumed?.(resumed);
    } catch (error) { setIssue(error instanceof Error ? error.message : copy("The session could not be resumed.", "无法恢复会话。")); }
    finally { setResuming(false); }
  };
  const reload = async () => {
    if (repairing || resuming || !repair?.offered) return;
    const generation = lifecycle.current;
    setRepairing(true); setIssue(undefined);
    let lost = false;
    let control: Awaited<ReturnType<typeof acquireControl>> | undefined;
    try {
      // A repair lease is acquired only after confirmation, without opening a
      // provider worker. The pool renews it while native read/commit is in flight.
      control = await acquireControl(session.id, () => { lost = true; });
      if (generation !== lifecycle.current) return;
      await control.check();
      if (generation !== lifecycle.current) return;
      if (lost) throw new Error(copy('Control of this history was lost. Try reloading again.', '此历史的控制权已丢失，请重新尝试加载。'));
      await request('chat.repair', {sessionId: session.id, leaseEpoch: control.epoch, operationId: operationId()});
      const snapshot = await request('chat.snapshot', {sessionId: session.id});
      if (generation !== lifecycle.current) return;
      setItems(snapshot.items); setRepair(snapshot.repair); setRepairDialog(false);
    } catch (error) {
      if (generation === lifecycle.current) setIssue(error instanceof Error ? error.message : copy('Saved history could not be reloaded.', '无法重新加载已保存的历史。'));
    } finally {
      control?.release();
      if (generation === lifecycle.current) setRepairing(false);
    }
  };
  return <section className="imported-history-view" aria-label={copy("Imported history", "已导入历史")}>
    <ChatForkMenu disabledReason={forkActions.disabledReason} busy={forkActions.busy} onFork={id=>void forkActions.fork(id)} zh={zh}/>
    <ChatForkStatus session={session} zh={zh} onOpenSession={onOpenSession}/>
    <header className="control-row-lg"><div><strong>{session.title || copy("Imported history", "已导入历史")}</strong><small>{copy("Read-only until you explicitly resume it.", "在显式恢复前仅可读取。")}</small></div>{repair?.offered && <button className="btn" onClick={() => setRepairDialog(true)} disabled={repairing || resuming}>{copy('Reload native history', '重新加载原生历史')}</button>}{session.readOnly && <button className="btn btn-primary" onClick={() => void resume()} disabled={resuming || repairing}>{copy("Resume explicitly", "显式恢复")}</button>}</header>
    {issue && <p className="surface-error" role="alert">{issue}</p>}
    <div className="imported-history-scroll">
      {!items && !issue && <p className="history-transcript-empty">{copy("Loading saved transcript…", "正在加载已保存的记录…")}</p>}
      {items && <HistoryTranscript items={items} empty={copy("This provider returned no structured transcript.", "该提供方未返回结构化记录。")} actions={item=>{
        const markdown=replyMarkdown(item);
        return markdown && isCompletedForkReply(item, items) ? <MessageActions markdown={markdown} copy={copy}><ChatForkButton itemId={item.id} disabledReason={forkActions.disabledReason} busy={forkActions.busy} onFork={id=>void forkActions.fork(id)} zh={zh}/></MessageActions> : null;
      }}/>}
    </div>
    {repairDialog && <SurfaceDialog size="sm" icon="clock" className="chat-repair-dialog" descriptionId={repairDescriptionId} title={copy('Reload saved history?', '重新加载已保存的历史？')} subtitle={session.title} onClose={() => { if (!repairing) setRepairDialog(false); }} footer={<>
      <button className="btn" autoFocus disabled={repairing} onClick={() => setRepairDialog(false)}>{copy('Cancel', '取消')}</button>
      <button className="btn btn-primary" disabled={repairing} onClick={() => void reload()}>{repairing ? copy('Reloading…', '正在重新加载…') : copy('Reload history', '重新加载历史')}</button>
    </>}><div id={repairDescriptionId} className="chat-repair-confirm"><p>{copy("Replace this imported transcript with the agent's saved history to restore its turn grouping. A backup is kept; pending requests will expire. Native history may omit some local tool details, answers or timings.", '用代理保存的历史替换此导入记录，以恢复回合分组。当前记录会保留备份，待处理请求将过期。原生历史可能缺少部分本地工具详情、回答或耗时。')}</p><p>{copy('This only reads saved history. It does not send a message or resume the agent. Drafts, queued prompts and review checkpoints are preserved.', '此操作仅读取已保存的历史，不会发送消息或恢复代理。草稿、排队提示词和审查检查点会保留。')}</p>{issue && <p className="surface-error" role="alert">{issue}</p>}</div></SurfaceDialog>}
  </section>;
}
