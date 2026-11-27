import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatItem, ChatPart, FileReference } from '@threadterm/protocol';
import { activeToolEntries, describeTool, drawerIsThinking, toolActivityWaitingLabel, toolFailureSummary, toolOutputPreview, toolSummary, toolSummaryLabel, toolSummaryText, withoutRecoveredFailures, type ToolActivityEntry, type ToolKind, type ToolThought } from '../toolActivity';
import { thoughtSummary, toolRow } from '../toolRow';
import { formatChatDuration } from '../chatPresentation';
import { foldCommentary, foldIsThinking, foldIsThinkingOnly, foldLatestStep, foldToolEntries, type FoldStep } from '../turnSegments';
import { approvalPreview } from '../approvalPreview';
import { approvalData } from '../chatApproval';
import { FileLinkedText, FileReferenceChips } from './FileReferenceText';
import { ToolCard } from './ToolCards';
import { Icon, type IconName } from './PrototypeIcon';
import './tool-activity.css';

const icons: Record<ToolKind, IconName> = { command: 'terminal', browser: 'globe', file: 'file', search: 'search', delegation: 'bot', mcp: 'plug', tool: 'wrench' };
type Copy = (en: string, zh: string) => string;

/** `onInspect` pauses follow while the reader opens or closes a fold; collapsing scrolls the header back into view. */
function useDisclosure(onInspect?: () => void) {
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
  return {
    open, setOpen, summaryRef,
    /** A click or key press on the header is inspection; closing it re-reveals the header afterwards. */
    inspect: () => { onInspect?.(); if (open) revealAfterCollapse.current = true; },
    collapse: () => { onInspect?.(); revealAfterCollapse.current = true; setOpen(false); },
  };
}

export function ToolActivity({ entries, thoughts = [], renderThought, active, awaitingApproval = false, awaitingQuestion = false, provider, copy, openFile, onInspect, openDiff, canOpenDiff, sessionCwd }: {
  entries: ToolActivityEntry[];
  /** Live thinking that belongs to this drawer; shown in order when it is open (see groupToolActivity). */
  thoughts?: ToolThought[];
  renderThought?: (item: ChatItem) => ReactNode;
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
  const { open, setOpen, collapse, inspect, summaryRef } = useDisclosure(onInspect);
  const running = activeToolEntries(entries, active);
  const current = running.at(-1);
  const recent = current ?? entries.at(-1);
  if (!recent) return null;
  const description = describeTool(recent.part, copy);
  const currentLabel = current ? toolRow(current.part, copy, sessionCwd).live : undefined;
  const waiting = toolActivityWaitingLabel(awaitingQuestion, awaitingApproval, copy);
  const thinking = active && !current && drawerIsThinking(entries, thoughts);
  const summaryCounts = toolSummary(entries);
  const summaryText = toolSummaryText(summaryCounts, copy);
  const headline = waiting ? waiting + (currentLabel ? `: ${currentLabel}` : '')
    : currentLabel ? currentLabel
      : thinking ? copy('Thinking…', '思考中…')
      : entries.length === 1 ? `${description.name}${description.detail ? ` · ${description.detail}` : ''}`
        : toolSummaryLabel(summaryCounts, copy) || copy(`${entries.length} tools`, `${entries.length} 项工具`);
  // Failures keep their own red count in the header; their reasons live in its title.
  const failures = current ? undefined : toolFailureSummary(withoutRecoveredFailures(entries), copy);
  const thoughtsBefore = (index: number) => renderThought && open ? thoughts.filter(thought => thought.before === index)
    .map(thought => {
      const content = renderThought(thought.item);
      return content == null ? null : <div key={thought.id} role="listitem" className="chat-tool-thought">{content}</div>;
    }) : null;
  const summaryAccessibleLabel = [headline, failures?.title ?? summaryText].filter(Boolean).join(' · ');
  return <article className={`v3-chat-message assistant is-native is-${provider} chat-tool-activity-card`}>
    <details className="chat-tool-activity" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} title={summaryAccessibleLabel} aria-label={summaryAccessibleLabel} onClick={inspect} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') inspect(); }}>
        <span className="chat-tool-head">
          {current || thinking ? <span className="chat-tool-spinner" aria-hidden="true" /> : <Icon name={icons[description.kind]} />}
          <span className={`chat-tool-current-action${current || thinking ? ' is-running' : ''}`} role="status" aria-live="polite" aria-atomic="true" title={summaryAccessibleLabel}>{headline}</span>
          {running.length > 1 && <span className="chat-tool-active-count">{running.length} {copy('running', '项执行中')}</span>}
          {failures && <span className="chat-tool-failed-count" title={failures.title}>{failures.label}</span>}
          {open && <span className="chat-tool-collapse-label">{copy('Collapse', '收起')}</span>}
          <Icon name="chevR" className="chat-tool-chevron" />
        </span>
      </summary>
      <div className="chat-tool-entries" role="list">{entries.map((entry, index) => <Fragment key={entry.id}>{thoughtsBefore(index)}<ToolCard
        entry={entry}
        open={open}
        active={active}
        awaitingApproval={awaitingApproval}
        sessionCwd={sessionCwd}
        copy={copy}
        openFile={openFile}
        openDiff={openDiff}
        canOpenDiff={canOpenDiff}
        onInspect={onInspect}
      /></Fragment>)}{thoughtsBefore(entries.length)}</div>
      <button type="button" className="btn btn-sm chat-tool-collapse" data-chat-collapse onClick={collapse}><Icon name="chevD" />{copy('Collapse tools', '收起工具详情')}</button>
    </details>
  </article>;
}

/** Milliseconds since `startedAt`, ticking once a second while mounted. */
function useElapsed(startedAt: string | undefined): number | undefined {
  const start = Date.parse(startedAt ?? '');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [start]);
  return Number.isFinite(start) ? Math.max(0, now - start) : undefined;
}

/**
 * One output segment of a turn: a single fold per maximal run of process parts (see turnSegments).
 * It never opens itself. Live it shows what is happening, a timer and the newest output or note;
 * settled it shows the outcome, the turn's duration when this is the turn's only fold (11-23), and
 * the counts. Failures a later call recovered from are not reported in red.
 */
export function ActivityFold({ steps, live, outcome, durationLabel, startedAt, awaitingApproval = false, awaitingQuestion = false, provider, copy, openFile, onInspect, openDiff, canOpenDiff, sessionCwd, renderNote }: {
  steps: FoldStep[];
  /** The newest segment of a turn that is still running: spinner, current step, note line. */
  live: boolean;
  /** A settled turn's recorded outcome, carried by its last fold only. */
  outcome?: 'failed' | 'interrupted';
  /** 「用时 2m 14s」 for the only fold of a settled turn; `TurnFooter` then leaves the duration out. */
  durationLabel?: string;
  /** When the live turn started, for the header's timer. */
  startedAt?: string;
  awaitingApproval?: boolean;
  awaitingQuestion?: boolean;
  provider: string;
  copy: Copy;
  openFile?: (reference: FileReference) => void;
  onInspect?: () => void;
  openDiff?: (path: string) => void;
  canOpenDiff?: (path: string) => boolean;
  sessionCwd?: string;
  /** Renders a commentary step's (or an open thought's) full text as Markdown; closed folds keep one line. */
  renderNote?: (part: ChatPart) => ReactNode;
}) {
  const { open, setOpen, collapse, inspect, summaryRef } = useDisclosure(onInspect);
  const elapsed = useElapsed(live ? startedAt : undefined);
  const entries = foldToolEntries(steps);
  const running = activeToolEntries(entries, live);
  const current = running.at(-1);
  const waiting = live ? toolActivityWaitingLabel(awaitingQuestion, awaitingApproval, copy) : undefined;
  const thinking = live && !current && foldIsThinking(steps);
  const counts = toolSummary(entries);
  const countsLabel = toolSummaryLabel(counts, copy);
  const failures = toolFailureSummary(withoutRecoveredFailures(entries), copy);
  const currentLabel = current ? toolRow(current.part, copy, sessionCwd).live : undefined;
  const output = current ? toolOutputPreview(current.part) : undefined;
  const noted = output ?? foldCommentary(steps);
  const latest = foldLatestStep(steps);
  const thinkingOnly = foldIsThinkingOnly(steps);
  const outcomeWord = outcome ? (outcome === 'failed' ? copy('Failed', '失败') : copy('Interrupted', '已中断')) : undefined;
  const settledLead = [outcomeWord, durationLabel].filter(Boolean).join(' · ');
  // The headline is what leads: live, the current step; settled, the outcome and the duration. The counts always
  // sit in `.chat-fold-counts`; with nothing to lead, they lead themselves and no 「已完成」 is added (11-23).
  let headline: string;
  let rest: string | undefined = countsLabel || undefined;
  if (live) {
    headline = waiting ? waiting + (currentLabel ? `: ${currentLabel}` : '')
      : currentLabel ?? (thinking ? copy('Thinking…', '思考中…') : latest ? stepHeadline(latest, copy, sessionCwd) : copy('Working…', '正在处理…'));
  } else if (settledLead) {
    headline = settledLead;
    if (thinkingOnly) rest = copy('Thought process', '思考过程');
  } else if (thinkingOnly) {
    headline = copy('Thought process', '思考过程');
  } else {
    headline = countsLabel ? '' : copy('Done', '已完成');
  }
  const icon = outcome === 'failed' ? 'close' : outcome === 'interrupted' ? 'info' : thinkingOnly && !outcome ? 'brain' : 'check';
  const accessible = [headline, rest, failures?.label].filter(Boolean).join(' · ');
  return <article className={`v3-chat-message assistant is-native is-${provider} chat-tool-activity-card is-fold`}>
    <details className={`chat-tool-activity chat-fold${live ? ' is-live' : ' is-settled'}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} title={accessible} aria-label={accessible} onClick={inspect} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') inspect(); }}>
        <span className="chat-tool-head">
          {live ? <span className="chat-tool-spinner" aria-hidden="true" /> : <Icon name={icon} className={`chat-fold-icon${outcome ? ' is-outcome' : ''}`} />}
          {headline && <span className={`chat-tool-current-action${live ? ' is-running' : ''}`} role="status" aria-live="polite" aria-atomic="true" title={accessible}>{headline}</span>}
          {rest && <span className={`chat-fold-counts${headline ? '' : ' is-lead'}`}>{headline ? `· ${rest}` : rest}</span>}
          {failures && <span className="chat-tool-failed-count chat-fold-failed" title={failures.title}>{failures.label}</span>}
          {live && elapsed !== undefined && <span className="chat-fold-elapsed" aria-hidden="true">{formatChatDuration(elapsed, false)}</span>}
          {open && <span className="chat-tool-collapse-label">{copy('Collapse', '收起')}</span>}
          <Icon name="chevR" className="chat-tool-chevron" />
        </span>
        {live && !open && noted && <span className={`chat-fold-note${output ? ' is-output' : ''}`}>{noted}</span>}
      </summary>
      <div className="chat-tool-entries" role="list">{steps.map(step => {
        if (step.kind === 'tool') return <ToolCard key={step.id} entry={step.entry} open={open} active={live} awaitingApproval={awaitingApproval} sessionCwd={sessionCwd} copy={copy} openFile={openFile} openDiff={openDiff} canOpenDiff={canOpenDiff} onInspect={onInspect} />;
        if (step.kind === 'thinking') return <FoldThinkingRow key={step.id} step={step} copy={copy} openFile={openFile} renderNote={renderNote} />;
        if (step.kind === 'commentary') return <FoldTextRow key={step.id} itemId={step.itemId} part={step.part} open={open} renderNote={renderNote} openFile={openFile} />;
        return <FoldApprovalRow key={step.id} itemId={step.itemId} part={step.part} copy={copy} />;
      })}</div>
      <button type="button" className="btn btn-sm chat-tool-collapse" data-chat-collapse onClick={collapse}><Icon name="chevD" />{copy('Collapse tools', '收起工具详情')}</button>
    </details>
  </article>;
}

/** The live headline of a segment with nothing running: what it did last. */
function stepHeadline(step: FoldStep, copy: Copy, sessionCwd?: string): string {
  if (step.kind === 'tool') return toolRow(step.entry.part, copy, sessionCwd).lines[0]?.label ?? '';
  if (step.kind === 'thinking') return thoughtSummary(step.part.text).title || copy('Thought process', '思考过程');
  if (step.kind === 'commentary') return firstLine(step.part.text);
  return approvalStepLabel(step.part, copy);
}

const firstLine = (value: string | undefined): string => (value ?? '').split(/\r?\n/).find(line => line.trim())?.trim() ?? '';

/** One dense row per thought: its title without Markdown markers; it expands to the rest only when the reader asks. */
function FoldThinkingRow({ step, copy, openFile, renderNote }: { step: Extract<FoldStep, { kind: 'thinking' }>; copy: Copy; openFile?: (reference: FileReference) => void; renderNote?: (part: ChatPart) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const { title, body } = thoughtSummary(step.part.text);
  const line = title || copy('Thought process', '思考过程');
  const expandable = Boolean(body && body !== title) || Boolean(step.part.fileReferences?.length);
  const content = <>
    <Icon name="brain" className="chat-fold-step-icon" />
    <span className="chat-fold-step-value is-dim" title={line}>{line}</span>
    {expandable && <Icon name="chevR" className="chat-fold-step-chevron" />}
  </>;
  if (!expandable) return <div className="chat-fold-step is-thinking" data-chat-item={step.itemId}><span className="chat-fold-step-line">{content}</span></div>;
  return <details className="chat-fold-step is-thinking" data-chat-item={step.itemId} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{content}</summary>
    {open && <div className="chat-fold-step-body">{renderNote?.({ ...step.part, type: 'text', text: body }) ?? <FileLinkedText text={body} openFile={openFile} />}<FileReferenceChips references={step.part.fileReferences} visibleText={body} openFile={openFile} /></div>}
  </details>;
}

/**
 * Commentary is part of what the agent said, so an open fold shows all of it; a closed fold is not
 * laid out, and keeps one line for find-in-page and `chatFlowSync`'s item anchors.
 */
function FoldTextRow({ itemId, part, open, renderNote, openFile }: { itemId: string; part: ChatPart; open: boolean; renderNote?: (part: ChatPart) => ReactNode; openFile?: (reference: FileReference) => void }) {
  const line = firstLine(part.text);
  if (!line) return null;
  if (open) {
    const full = part.text?.trim() ?? line;
    return <div className="chat-fold-step is-note is-full" data-chat-item={itemId}>
      <div className="chat-fold-note-body">{renderNote?.(part) ?? <FileLinkedText text={full} openFile={openFile} />}</div>
    </div>;
  }
  return <div className="chat-fold-step is-note" data-chat-item={itemId}>
    <span className="chat-fold-step-value" title={part.text?.trim()}><FileLinkedText text={line} openFile={openFile} /></span>
  </div>;
}

function FoldApprovalRow({ itemId, part, copy }: { itemId: string; part: ChatPart; copy: Copy }) {
  const data = approvalData(part);
  const preview = approvalPreview(part);
  const detail = preview?.kind === 'command' ? preview.command
    : preview?.kind === 'edit' ? preview.files[0]?.path
      : data?.title;
  return <div className={`chat-fold-step is-approval is-${part.status ?? 'resolved'}`} data-chat-item={itemId}>
    <span className="chat-fold-step-key">{copy('Approval', '批准')}</span>
    <span className="chat-fold-step-value">{approvalStepLabel(part, copy)}{detail ? <>{copy(': ', '：')}<code>{detail}</code></> : null}</span>
  </div>;
}

/**
 * What happened to a resolved interaction. The runtime records the plan outcome and the
 * question answers, but not which button a permission request was answered with, so a
 * plain approval says only that it was decided.
 */
function approvalStepLabel(part: ChatPart, copy: Copy): string {
  const data = approvalData(part);
  if (part.status === 'dismissed') return copy('Dismissed', '已忽略');
  if (data?.planOutcome === 'approved') return copy('Plan approved', '已批准计划');
  if (data?.planOutcome === 'changes_requested') return copy('Changes requested', '已要求修改');
  if (data?.planOutcome === 'abandoned') return copy('Plan abandoned', '已放弃计划');
  const answers = Object.values(data?.answerSummary ?? {}).filter(value => value.trim());
  if (answers.length) return `${copy('Answered', '已回答')}${copy(': ', '：')}${answers.join(' · ')}`;
  if (data?.interaction === 'question' || data?.interaction === 'userInput' || data?.form) return copy('Answered', '已回答');
  return copy('Decided', '已作出决定');
}
