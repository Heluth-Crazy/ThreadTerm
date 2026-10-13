import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ChatAnswerResponse, ChatPart } from '@threadterm/protocol';
import { approvalData, planApprovalEnabled } from '../chatApproval';
import './plan-approval.css';

type Copy = (en: string, zh: string) => string;

export function PlanApprovalCard({ part, writable, submitting, onRespond, copy }: {
  part: ChatPart;
  writable: boolean;
  submitting?: string;
  onRespond?: (response: ChatAnswerResponse) => void;
  copy: Copy;
}) {
  const data = approvalData(part);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(data?.plan ?? '', { async: false }) as string), [data?.plan]);
  if (!data) return null;
  const pending = part.status === 'pending';
  const waitingForPrompt = data.waitingForPrompt === true;
  const enabled = planApprovalEnabled(part, writable, submitting);
  const outcome = data.planOutcome;
  return <section className={`chat-approval-card chat-plan-approval ${part.status ?? 'pending'}`} aria-label={copy('Plan review', '计划审核')}>
    <span className="chat-plan-approval-title">{copy('Review the plan', '审核计划')}</span>
    <div className="chat-plan-approval-body" role="region" tabIndex={0} aria-label={copy('Proposed plan', '拟议计划')}>
      {data.plan?.trim() ? <div className="codex-markdown" dangerouslySetInnerHTML={{ __html: html }} /> : <p>{copy('The agent submitted an empty plan.', '代理提交了空计划。')}</p>}
    </div>
    {outcome && <p className="chat-plan-receipt">
      {outcome === 'approved' ? copy('Plan approved', '计划已批准') : outcome === 'abandoned' ? copy('Plan abandoned', '计划已放弃') : copy('Changes requested', '已要求修改')}
      {outcome === 'changes_requested' && data.feedback ? ': ' + data.feedback : ''}
    </p>}
    {!pending && !outcome && <p>{copy('This plan review is no longer active.', '此计划审核已失效。')}</p>}
    {waitingForPrompt && <p>{copy('Send your changes in the composer below.', '请在下方输入框中发送修改意见。')}</p>}
    {pending && !waitingForPrompt && <>
      <div className="chat-plan-approval-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={!enabled} onClick={() => onRespond?.({ action: 'approve' })}>
          {submitting === 'approve' ? copy('Submitting…', '提交中…') : copy('Approve & build', '批准并执行')}
        </button>
        <button type="button" className="btn btn-sm" disabled={!enabled} aria-expanded={editing} onClick={() => data.runtimeOwned ? onRespond?.({ action: 'request_changes' }) : setEditing(value => !value)}>
          {copy('Request changes', '要求修改')}
        </button>
        <button type="button" className="btn btn-sm btn-danger" disabled={!enabled} onClick={() => onRespond?.({ action: 'abandon' })}>{copy('Abandon', '放弃')}</button>
      </div>
      {editing && !data.runtimeOwned && <div className="chat-plan-feedback">
        <label>{copy('What should change?', '需要修改哪些内容？')}
          <textarea value={feedback} disabled={!enabled} maxLength={16000} onChange={event => setFeedback(event.target.value)} />
        </label>
        <button type="button" className="btn btn-sm" disabled={!enabled || !feedback.trim()} onClick={() => onRespond?.({ action: 'request_changes', feedback: feedback.trim() })}>{copy('Send', '发送')}</button>
      </div>}
    </>}
  </section>;
}
