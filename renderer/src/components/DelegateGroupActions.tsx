import { useRef, useState } from 'react';
import type { CatalogVisibility, Session } from '@threadterm/protocol';
import { operationId, request } from '../bridge';
import { hasDirtyEditorsInScope } from '../dirtyEditors';
import { useTranslation } from '../i18n';
import { CatalogPopover } from './CatalogActions';
import { Icon } from './PrototypeIcon';
import { SurfaceDialog } from './SurfaceDialog';
import './catalog-active-delete-dialog.css';

type Next = Extract<CatalogVisibility['visibility'], 'archived' | 'removed'>;
export type DelegateGroupPlan = {
  /** One catalog.visibility.update per session, with the revision it must still have. */
  updates: { id: string; title: string; expectedRevision: number }[];
  /** Sessions that became active (or have unsaved edits) since the fold was drawn: the group is refused. */
  blocked: { id: string; title: string; reason: 'active' | 'edited' }[];
};

const isActiveSession = (session: Session) => !session.readOnly && ['starting', 'running', 'idle', 'waiting'].includes(session.status);

/** Which of the fold's sessions to update, against the latest snapshot. Sessions already gone are skipped. */
export function planDelegateGroup(sessionIds: readonly string[], sessions: readonly Session[], visibility: readonly CatalogVisibility[],
  dirty: (session: Session) => boolean = () => false): DelegateGroupPlan {
  const plan: DelegateGroupPlan = { updates: [], blocked: [] };
  for (const id of sessionIds) {
    const session = sessions.find(row => row.id === id);
    if (!session) continue;
    if (isActiveSession(session)) plan.blocked.push({ id, title: session.title, reason: 'active' });
    else if (dirty(session)) plan.blocked.push({ id, title: session.title, reason: 'edited' });
    else {
      const entry = visibility.find(row => row.kind === 'session' && row.id === id);
      plan.updates.push({ id, title: session.title, expectedRevision: entry?.revision ?? session.organizationRevision ?? 0 });
    }
  }
  return plan;
}

/**
 * The ⋯ menu of a parent's "N finished" delegate fold: archive or delete the whole group in the ThreadTerm catalogue.
 * Same rules as one session (CatalogActions): nothing active, no unsaved edits, the record's current revision.
 */
export function DelegateGroupActions({ parentTitle, sessionIds, sessions, onChanged, onMenuOpenChange }: {
  parentTitle: string;
  sessionIds: readonly string[];
  sessions: readonly Session[];
  onChanged: () => void;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const { locale } = useTranslation(), zh = locale === 'zh-CN', text = (en: string, cn: string) => zh ? cn : en;
  const [anchor, setAnchor] = useState<HTMLElement>(), [dialog, setDialog] = useState<Next>();
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string>(), locked = useRef(false);
  const group = sessionIds.map(id => sessions.find(row => row.id === id)).filter((row): row is Session => Boolean(row));
  const count = group.length;
  const groupLabel = text(`${count} finished delegate${count === 1 ? '' : 's'}`, `${count} 个已结束的委派`);
  const close = () => { setAnchor(undefined); onMenuOpenChange?.(false); };
  const begin = (next: Next) => { close(); setIssue(undefined); setDialog(next); };
  const names = (rows: readonly { title: string }[]) => rows.map(row => row.title).join(zh ? '、' : ', ');
  const apply = async (next: Next) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setIssue(undefined);
    try {
      const [visibility, snapshot] = await Promise.all([request('catalog.visibility.list', {}), request('runtime.snapshot', {})]);
      const plan = planDelegateGroup(sessionIds, snapshot.sessions, visibility, session => hasDirtyEditorsInScope({ projectId: session.projectId ?? '', sessionId: session.id }));
      if (plan.blocked.length) {
        const active = plan.blocked.filter(row => row.reason === 'active'), edited = plan.blocked.filter(row => row.reason === 'edited');
        throw new Error([
          active.length ? text(`Still running: ${names(active)}. End them first.`, `仍在运行：${names(active)}。请先结束。`) : '',
          edited.length ? text(`Unsaved edits: ${names(edited)}. Save or close them first.`, `有未保存的修改：${names(edited)}。请先保存或关闭。`) : '',
        ].filter(Boolean).join(' '));
      }
      const failed: { title: string; message: string }[] = [];
      for (const update of plan.updates) {
        try {
          await request('catalog.visibility.update', { kind: 'session', id: update.id, visibility: next, expectedRevision: update.expectedRevision, operationId: operationId() });
        } catch (error) {
          failed.push({ title: update.title, message: error instanceof Error ? error.message : String(error) });
        }
      }
      onChanged();
      if (failed.length) throw new Error(text(`Not changed: ${failed.map(row => `${row.title} (${row.message})`).join(', ')}`, `未完成：${failed.map(row => `${row.title}（${row.message}）`).join('、')}`));
      setDialog(undefined);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : String(error));
    } finally {
      locked.current = false; setBusy(false);
    }
  };
  if (!count) return null;
  const shown = group.slice(0, 5).map(row => row.title).join(zh ? '、' : ', ') + (count > 5 ? text(` and ${count - 5} more`, ` 等 ${count} 个`) : '');
  return <>
    <button type="button" className="icon-btn row-more" aria-label={`${groupLabel} ${text('Manage', '管理')}`} aria-expanded={Boolean(anchor)} data-testid="delegate-group-more"
      onClick={event => { const next = anchor ? undefined : event.currentTarget; setAnchor(next); onMenuOpenChange?.(Boolean(next)); }}><Icon name="more" /></button>
    {anchor && <CatalogPopover anchor={anchor} onClose={close} label={groupLabel}>
      <div className="menu-label">{groupLabel}</div>
      <button type="button" role="menuitem" className="menu-item" disabled={busy} data-testid="delegate-group-archive" onClick={() => begin('archived')}><Icon name="archive" />{text(`Archive all ${count}`, `归档这 ${count} 个`)}</button>
      <button type="button" role="menuitem" className="menu-item danger" disabled={busy} data-testid="delegate-group-delete" onClick={() => begin('removed')}><Icon name="trash" />{text(`Delete all ${count}`, `删除这 ${count} 个`)}</button>
      <div className="menu-note">{text('Local catalogue only; files and Agent CLI history are retained.', '仅本应用归档，不影响磁盘或 Agent CLI')}</div>
    </CatalogPopover>}
    {dialog && <SurfaceDialog title={dialog === 'archived' ? text('Archive finished delegates', '归档已结束的委派') : text('Delete finished delegates', '删除已结束的委派')}
      subtitle={`${parentTitle} · ${groupLabel}`} icon={dialog === 'archived' ? 'archive' : 'trash'} className="catalog-confirm-dialog" size="sm"
      onClose={() => { if (!busy) setDialog(undefined); }}
      footer={<><button className="btn" disabled={busy} onClick={() => setDialog(undefined)}>{text('Cancel', '取消')}</button>
        <button className={`btn ${dialog === 'archived' ? 'btn-primary' : 'btn-danger'}`} disabled={busy} data-testid="delegate-group-confirm" onClick={() => void apply(dialog)}>
          {busy ? text('Working…', '正在处理…') : dialog === 'archived' ? text(`Archive ${count}`, `归档 ${count} 个`) : text(`Delete ${count}`, `删除 ${count} 个`)}</button></>}>
      <p className="dlg-text">{dialog === 'archived'
        ? text('Hide these delegates from the catalogue. Restore any of them from the worktree menu under Archived sessions.', '从目录中隐藏这些委派会话。可以在工作树菜单的"归档的会话"里逐个恢复。')
        : text('Remove these delegates from the ThreadTerm catalogue.', '从 ThreadTerm 目录中删除这些委派会话。')}</p>
      <p className="note">{shown}</p>
      <p className="note">{text('Files and Agent CLI history are retained. The parent session is not changed.', '磁盘文件和 Agent CLI 历史会保留；上级会话不受影响。')}</p>
      {issue && <div className="surface-error" role="alert"><span>{issue}</span></div>}
    </SurfaceDialog>}
  </>;
}
