import { useEffect, useId, useRef, useState } from 'react';
import type { ContextItem } from '../chatContext';
import type { FileCommentsHost } from '../fileCommentsHost';
import { contextError } from '../contextErrors';
import { Icon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import { Select } from './ui/Select';
import { referencePath } from '../workbench/agentReference';

type PendingContext = { host: FileCommentsHost; context: ContextItem; zh: boolean; sourceRoot?: string };
let showDialog: ((pending: PendingContext) => void) | undefined;

async function attach({ host, context, zh, sourceRoot }: PendingContext, receiverId: string) {
  const receiver = host.receivers.find(value => value.id === receiverId);
  if (!receiver || !host.attachContext) throw new Error(zh ? '请先在此工作区打开一个聊天会话。' : 'Open a Chat session in this workspace first.');
  const item = sourceRoot && (context.kind === 'file' || context.kind === 'diff') ? { ...context, path: referencePath(context.path, sourceRoot, receiver.root) } : context;
  await host.attachContext(receiver.id, item);
  host.notice?.(zh ? '上下文已加入消息草稿。' : 'Context added to the message draft.');
}

/** The button only captures the item — a terminal selection is read at click time — and hands it to the dialog host,
 * because the toolbar that shows it (a terminal's selection bar) disappears with its selection. */
export function ContextSendAction({ host, item, zh, label, iconOnly = false, testId, sourceRoot }: {
  host: FileCommentsHost | undefined;
  item: ContextItem | (() => Promise<ContextItem>);
  zh: boolean;
  label?: string;
  iconOnly?: boolean;
  testId?: string;
  sourceRoot?: string;
}) {
  const pending = useRef(false);
  if (!host?.attachContext) return null;
  const title = label ?? (zh ? '发送给 Agent' : 'Send to agent');
  const start = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const context = typeof item === 'function' ? await item() : item;
      const request = { host, context, zh, sourceRoot };
      if (showDialog) showDialog(request);
      else await attach(request, host.defaultReceiverId ?? host.receivers[0]?.id ?? '');
    } catch (error) { host.notice?.(contextError(error, zh)); }
    finally { pending.current = false; }
  };
  return <button type="button" className={iconOnly ? 'icon-btn' : 'btn btn-sm'} title={title} aria-label={title} data-testid={testId} onClick={() => void start()}><Icon name="spark"/>{!iconOnly && title}</button>;
}

/** Mounted once beside the workspace's context provider; owns the receiver dialog for every Send to agent action. */
export function ContextSendDialogHost() {
  const [pending, setPending] = useState<PendingContext>();
  const [receiverId, setReceiverId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const id = useId();
  useEffect(() => {
    const show = (next: PendingContext) => { setPending(next); setReceiverId(undefined); setIssue(undefined); };
    showDialog = show;
    return () => { if (showDialog === show) showDialog = undefined; };
  }, []);
  if (!pending) return null;
  const { host, zh } = pending, copy = (en: string, cn: string) => zh ? cn : en;
  const receiver = host.receivers.find(value => value.id === receiverId) ?? host.receivers.find(value => value.id === host.defaultReceiverId) ?? host.receivers[0];
  const close = () => { if (!busy) setPending(undefined); };
  const add = async () => {
    if (!receiver || busy) return;
    setBusy(true); setIssue(undefined);
    try { await attach(pending, receiver.id); setPending(undefined); }
    catch (error) { setIssue(contextError(error, zh)); }
    finally { setBusy(false); }
  };
  return <SurfaceDialog title={copy('Send to agent', '发送给 Agent')} variant="plain" size="sm" onClose={close} footer={<><button type="button" className="btn" disabled={busy} onClick={close}>{copy('Cancel', '取消')}</button><button type="button" className="btn btn-primary" disabled={busy || !receiver} onClick={() => void add()}>{busy ? copy('Adding…', '正在添加…') : copy('Add context', '添加上下文')}</button></>}>
    {receiver ? <div className="field"><label htmlFor={id}>{copy('Send to session', '发送到会话')}</label><Select id={id} value={receiver.id} disabled={busy} aria-label={copy('Send to session', '发送到会话')} onChange={event => setReceiverId(event.target.value)}>{host.receivers.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</Select></div> : <p>{copy('Open a Chat session in this workspace first.', '请先在此工作区打开一个聊天会话。')}</p>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </SurfaceDialog>;
}
