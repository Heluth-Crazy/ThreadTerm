import { useLayoutEffect, useRef, useState } from 'react';
import type { FileReference } from '@threadterm/protocol';
import { activeToolEntries, describeTool, toolActivityPreview, toolActivityWaitingLabel, toolFailureSummary, toolSummary, toolSummaryLabel, toolSummaryText, type ToolActivityEntry, type ToolKind } from '../toolActivity';
import { FileReferenceChips } from './FileReferenceText';
import { ToolCard } from './ToolCards';
import { Icon } from './PrototypeIcon';
import './tool-activity.css';

const icons: Record<ToolKind, string> = { command: 'terminal', browser: 'globe', file: 'file', search: 'search', delegation: 'agents', mcp: 'plug', tool: 'wrench' };

export function ToolActivity({ entries, active, awaitingApproval = false, awaitingQuestion = false, provider, copy, openFile, onInspect, openDiff, canOpenDiff, sessionCwd }: {
  entries: ToolActivityEntry[];
  active: boolean;
  awaitingApproval?: boolean;
  awaitingQuestion?: boolean;
  provider: string;
  copy: (en: string, zh: string) => string;
  openFile?: (reference: FileReference) => void;
  onInspect?: () => void;
  openDiff?: (path: string) => void;
  canOpenDiff?: (path: string) => boolean;
  sessionCwd?: string;
}) {
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);
  const revealAfterCollapse = useRef(false);
  useLayoutEffect(() => {
    if (open || !revealAfterCollapse.current) return;
    revealAfterCollapse.current = false;
    const summary = summaryRef.current, log = summary?.closest<HTMLElement>('.chat-subagent-transcript, .v3-chat-log');
    if (!summary || !log) return;
    const header = summary.getBoundingClientRect(), viewport = log.getBoundingClientRect();
    if (header.top < viewport.top || header.bottom > viewport.bottom) log.scrollTop += header.top - viewport.top - 8;
    summary.focus({ preventScroll: true });
  }, [open]);
  const running = activeToolEntries(entries, active);
  const current = running.at(-1);
  const recent = current ?? entries.at(-1);
  const preview = toolActivityPreview(entries, active);
  const previewEntry = preview && entries.find(entry => entry.id === preview.entryId);
  const previewInfo = previewEntry && describeTool(previewEntry.part, copy);
  const previewTitle = previewInfo ? `${previewInfo.name}${previewInfo.detail ? ` · ${previewInfo.detail}` : ''}: ${preview!.text}` : preview?.text;
  if (!recent) return null;
  const description = describeTool(recent.part, copy);
  const action = ['browser', 'mcp', 'delegation', 'tool'].includes(description.kind)
    ? `${description.name}${description.detail ? ` · ${description.detail}` : ''}`
    : description.detail || description.name;
  const waiting = toolActivityWaitingLabel(awaitingQuestion, awaitingApproval, copy);
  const summaryCounts = toolSummary(entries);
  const summaryText = toolSummaryText(summaryCounts, copy);
  const headline = waiting ? waiting + (current ? `: ${action}` : '')
    : current ? `${description.action}: ${action}`
      : entries.length === 1 ? `${description.name}${description.detail ? ` · ${description.detail}` : ''}`
        : toolSummaryLabel(summaryCounts, copy) || copy(`${entries.length} tools`, `${entries.length} 项工具`);
  const failures = toolFailureSummary(entries, copy);
  const summaryAccessibleLabel = !current && !waiting && entries.length > 1 ? summaryText || headline : [headline, summaryText].filter(Boolean).join(' · ');
  return <article className={`v3-chat-message assistant is-native is-${provider} chat-tool-activity-card`}>
    <details className="chat-tool-activity" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} title={summaryAccessibleLabel} aria-label={summaryAccessibleLabel} onClick={() => { onInspect?.(); if (open) revealAfterCollapse.current = true; }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { onInspect?.(); if (open) revealAfterCollapse.current = true; } }}>
        <span className="chat-tool-head">
          {current ? <span className="chat-tool-spinner" aria-hidden="true" /> : <Icon name={icons[description.kind]} />}
          <span className={`chat-tool-current-action${current ? ' is-running' : ''}`} role="status" aria-live="polite" aria-atomic="true" title={summaryAccessibleLabel}>{headline}</span>
          {running.length > 1 && <span className="chat-tool-active-count">{running.length} {copy('running', '项执行中')}</span>}
          {open && <span className="chat-tool-collapse-label">{copy('Collapse', '收起')}</span>}
          <Icon name="chevR" className="chat-tool-chevron" />
        </span>
        {preview && <span className="chat-tool-output-preview" role="status" aria-live="polite" aria-atomic="true" data-preview-tool-id={preview.entryId} title={previewTitle}><span className="chat-tool-output-label">{copy('Latest output', '最新输出')}</span><span>{preview.text}</span></span>}
        {failures && <span className="chat-tool-failures" title={failures.title}><span className="chat-tool-failed-count">{failures.label}</span><span>{':\u00a0'}</span><span className="chat-tool-failure-reason">{failures.reason}</span></span>}
      </summary>
      <div className="chat-tool-entries" role="list">{entries.map((entry, index) => <ToolCard
        key={entry.id}
        entry={entry}
        index={index}
        open={open}
        active={active}
        awaitingApproval={awaitingApproval}
        sessionCwd={sessionCwd}
        copy={copy}
        openFile={openFile}
        openDiff={openDiff}
        canOpenDiff={canOpenDiff}
      />)}</div>
      <button type="button" className="btn btn-sm chat-tool-collapse" data-chat-collapse onClick={() => { onInspect?.(); revealAfterCollapse.current = true; setOpen(false); }}><Icon name="chevD" />{copy('Collapse tools', '收起工具详情')}</button>
    </details>
  </article>;
}
