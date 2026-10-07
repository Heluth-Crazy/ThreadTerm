import { useState } from 'react';
import type { FileReference } from '@threadterm/protocol';
import { activeToolEntries, describeTool, toolStatus, type ToolActivityEntry, type ToolKind } from '../toolActivity';
import { partBody } from '../chatPresentation';
import { isChatImage } from '../chatImages';
import { FileLinkedText, FileReferenceChips } from './FileReferenceText';
import { Icon } from './PrototypeIcon';
import './tool-activity.css';

const icons: Record<ToolKind, string> = { command: 'terminal', browser: 'popout', file: 'file', search: 'search', delegation: 'export', mcp: 'spark', tool: 'spark' };

export function ToolActivity({ entries, active, awaitingApproval = false, provider, copy, openFile }: {
  entries: ToolActivityEntry[];
  active: boolean;
  awaitingApproval?: boolean;
  provider: string;
  copy: (en: string, zh: string) => string;
  openFile?: (reference: FileReference) => void;
}) {
  const [open, setOpen] = useState(false);
  const running = activeToolEntries(entries, active);
  const current = running.at(-1);
  const recent = current ?? entries.at(-1);
  if (!recent) return null;
  const description = describeTool(recent.part, copy);
  const action = ['browser', 'mcp', 'delegation', 'tool'].includes(description.kind)
    ? `${description.name}${description.detail ? ` · ${description.detail}` : ''}`
    : description.detail || description.name;
  const headline = awaitingApproval ? copy('Waiting for approval', '等待批准') + (current ? `: ${action}` : '')
    : current ? `${description.action}: ${action}`
      : `${copy('Tool activity', '工具执行')} · ${copy('Last', '最近')}: ${description.name}${description.detail ? ` · ${description.detail}` : ''}`;
  const failures = entries.filter(entry => ['failed', 'cancelled'].includes(toolStatus(entry.part)));
  const statusText = (entry: ToolActivityEntry) => {
    switch (toolStatus(entry.part)) {
      case 'running': return active ? awaitingApproval ? copy('In progress', '处理中') : copy('Running', '执行中') : copy('Inactive', '已结束');
      case 'complete': return copy('Completed', '已完成');
      case 'failed': return copy('Failed', '失败');
      case 'cancelled': return copy('Interrupted', '已中断');
      default: return copy('Recorded', '已记录');
    }
  };
  return <article className={`v3-chat-message assistant is-native is-${provider} chat-tool-activity-card`}>
    <details className="chat-tool-activity" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name={icons[description.kind]} />
        <span className={`chat-tool-current-action${current ? ' is-running' : ''}`} role="status" aria-live="polite" aria-atomic="true" title={current ? headline : action}>{headline}</span>
        <span className="chat-tool-count">{entries.length} {copy('tools', '项工具')}</span>
        {running.length > 1 && <span className="chat-tool-active-count">{running.length} {copy('running', '项执行中')}</span>}
        {!!failures.length && <span className="chat-tool-failed-count">{failures.length} {copy('failed / interrupted', '项失败或中断')}</span>}
        <Icon name="chevR" className="chat-tool-chevron" />
      </summary>
      {!current && <div className="chat-tool-recent">{copy('Last', '最近')}: {description.name}{description.detail ? ` · ${description.detail}` : ''}</div>}
      <div className="chat-tool-entries">{entries.map((entry, index) => {
        const info = describeTool(entry.part, copy), state = toolStatus(entry.part), body = partBody(entry.part);
        const data = entry.part.data && typeof entry.part.data === 'object' ? entry.part.data as { images?: unknown } : {};
        const images = Array.isArray(data.images) ? data.images.filter(isChatImage) : [];
        return <div className={`chat-tool-entry is-${state}`} key={entry.id} data-tool-id={entry.part.toolId || entry.id} data-tool-kind={info.kind} data-tool-status={state}>
          <div className="chat-tool-entry-label"><span className="chat-tool-step">{index + 1}</span><Icon name={icons[info.kind]} /><strong>{info.name}</strong><span className="chat-tool-entry-status">{statusText(entry)}</span></div>
          {info.detail && <div className="chat-tool-entry-detail">{info.detail}</div>}
          {!!images.length && <div className="chat-message-images">{images.map((image, imageIndex) => <img src={image} key={imageIndex} alt={`${copy('Tool image', '工具图片')} ${imageIndex + 1}`} loading="lazy" />)}</div>}
          {body && <pre><FileLinkedText text={body} openFile={openFile} /></pre>}
          <FileReferenceChips references={entry.part.fileReferences} visibleText={body} openFile={openFile} />
        </div>;
      })}</div>
    </details>
    {!!failures.length && <div className="chat-tool-failures">{failures.map(entry => {
      const info = describeTool(entry.part, copy);
      return <p key={entry.id}>{statusText(entry)}: {info.name}{info.detail ? ` · ${info.detail}` : ''}</p>;
    })}</div>}
  </article>;
}
