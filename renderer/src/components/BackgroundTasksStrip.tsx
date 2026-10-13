import { useEffect, useId, useRef, useState } from 'react';
import type { ChatBackgroundTask } from '@threadterm/protocol';
import { backgroundElapsed } from '../backgroundTasks';
import { formatChatDuration } from '../chatPresentation';
import './background-tasks.css';

type Copy = (en: string, zh: string) => string;
export function BackgroundTasksStrip({ tasks, copy, zh, writable, onExpand, onStop, onOutput, canOutput }: {
  tasks: readonly ChatBackgroundTask[]; copy: Copy; zh: boolean; writable: boolean;
  onExpand: () => Promise<void>; onStop: (task: ChatBackgroundTask) => Promise<void>;
  onOutput: (task: ChatBackgroundTask) => void; canOutput: (task: ChatBackgroundTask) => boolean;
}) {
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [issue, setIssue] = useState<string>();
  const toggle = useRef<HTMLButtonElement>(null), inFlight = useRef(new Set<string>()), refreshing = useRef(false);
  const bodyId = useId();
  useEffect(() => {
    for (const id of inFlight.current) {
      if (!tasks.some(task => task.id === id && task.status === 'running')) inFlight.current.delete(id);
    }
    setPending(current => current.size === inFlight.current.size ? current : new Set(inFlight.current));
  }, [tasks]);
  const refresh = () => {
    if (refreshing.current) return;
    refreshing.current = true; setLoading(true); setIssue(undefined);
    void onExpand().catch(() => setIssue(copy('Background tasks could not be refreshed.', '无法刷新后台任务。')))
      .finally(() => { refreshing.current = false; setLoading(false); });
  };
  const stop = (task: ChatBackgroundTask) => {
    if (!writable || !task.canStop || task.status !== 'running' || inFlight.current.has(task.id)) return;
    inFlight.current.add(task.id); setPending(new Set(inFlight.current)); setIssue(undefined);
    void onStop(task).catch(() => {
      inFlight.current.delete(task.id); setPending(new Set(inFlight.current));
      setIssue(copy('The task could not be stopped. Refresh its status before trying again.', '未能停止任务，请刷新状态后再试。'));
    });
  };
  if (!tasks.length) return null;
  const now = Date.now();
  return <section className="chat-background-tasks" data-testid="background-tasks-strip" aria-label={copy('Background tasks', '后台任务')} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); toggle.current?.focus(); }
  }}>
    <button ref={toggle} type="button" className="btn btn-sm btn-ghost" aria-expanded={open} aria-controls={bodyId} onClick={() => { if (!open) refresh(); setOpen(value => !value); }}>
      {copy(`${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'}`, `${tasks.length} 个后台任务`)}
    </button>
    {open && <div className="chat-background-body" id={bodyId}>
      {loading && <p role="status">{copy('Refreshing tasks…', '正在刷新任务…')}</p>}
      {issue && <div className="chat-background-issue" role="alert"><span>{issue}</span><button type="button" className="btn btn-sm" disabled={loading} onClick={refresh}>{copy('Refresh', '刷新')}</button></div>}
      <ul className="chat-background-list">
        {tasks.map(task => {
          const elapsed = backgroundElapsed(task, now);
          const label = task.status === 'running' ? copy('Running', '运行中') : task.status === 'completed' ? copy('Completed', '已完成') : task.status === 'failed' ? copy('Failed', '失败') : copy('Stopped', '已停止');
          const stopping = pending.has(task.id);
          return <li className="chat-background-row" key={task.id} data-task-id={task.id}>
            <div className="chat-background-description"><span className="chat-background-title" title={task.command ?? task.title}>{task.title}</span>
              <span className={`chat-background-status${task.status === 'failed' ? ' is-failed' : ''}`}>{label}</span>
              {elapsed !== undefined && <span className="chat-background-elapsed">{formatChatDuration(elapsed, zh)}</span>}
            </div>
            <div className="chat-background-actions">
              {canOutput(task) && <button type="button" className="btn btn-sm" onClick={() => onOutput(task)}>{copy('Output', '输出')}</button>}
              {task.canStop && task.status === 'running' && <button type="button" className="btn btn-sm btn-danger" disabled={!writable || stopping} title={!writable ? copy('Chat control is required to stop a task.', '停止任务需要聊天控制权。') : undefined} aria-label={`${copy('Stop task', '停止任务')}: ${task.title}`} onClick={() => stop(task)}>{stopping ? copy('Stopping…', '正在停止…') : copy('Stop', '停止')}</button>}
            </div>
          </li>;
        })}
      </ul>
    </div>}
  </section>;
}
