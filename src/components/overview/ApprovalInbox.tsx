import { useState } from 'react';
import type { ApprovalRequest } from '../../stores/attentionStore';
import { respondToApprovalRequest } from '../../lib/approval-actions';

export interface InboxSessionLabel {
  title: string;
  subtitle: string;
}

interface ApprovalInboxProps {
  requests: ApprovalRequest[];
  onOpenSession: (sessionId: string) => void;
  sessionLabels?: Record<string, InboxSessionLabel>;
  focusedSessionId?: string;
}

const RISK_TONE: Record<ApprovalRequest['riskLevel'], string> = {
  low: 'text-slate-500 bg-slate-500/10',
  medium: 'text-amber-600 bg-amber-500/10',
  high: 'text-red-500 bg-red-500/10',
};

export default function ApprovalInbox({
  requests,
  onOpenSession,
  sessionLabels = {},
  focusedSessionId,
}: ApprovalInboxProps) {
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDecision(sessionId: string, requestId: string, approved: boolean) {
    setBusySessionId(sessionId);
    setError(null);
    try {
      await respondToApprovalRequest(sessionId, requestId, approved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to respond to approval request.');
    } finally {
      setBusySessionId(null);
    }
  }

  return (
    <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Approval Inbox</h2>
          <p className="text-xs text-muted-foreground">Approve or deny tool calls without leaving Mission Control.</p>
        </div>
        <div className="flex items-center gap-2">
          {requests.length > 0 ? (
            <button
              type="button"
              onClick={() => onOpenSession(requests[0].sessionId)}
              className="inline-flex h-8 items-center rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              Review next
            </button>
          ) : null}
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{requests.length}</span>
        </div>
      </div>

      {error ? (
        <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-500">
          {error}
        </div>
      ) : null}

      {requests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-6 text-sm text-muted-foreground">
          No pending approvals.
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => {
            const isBusy = busySessionId === request.sessionId;
            const sessionLabel = sessionLabels[request.sessionId];
            const isFocused = focusedSessionId === request.sessionId;
            return (
              <div
                key={request.id}
                tabIndex={-1}
                data-approval-session-id={request.sessionId}
                data-control-plane-focused={isFocused ? 'true' : 'false'}
                className={`rounded-xl border bg-background/70 p-3 ${
                  isFocused
                    ? 'border-primary/40 ring-2 ring-primary/20 ring-offset-2 ring-offset-background'
                    : 'border-border/60'
                }`}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    {sessionLabel ? (
                      <div className="mb-2">
                        <div className="truncate text-xs font-medium text-foreground">{sessionLabel.title}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{sessionLabel.subtitle}</div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{request.toolName || 'Approval required'}</span>
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                        pending
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RISK_TONE[request.riskLevel]}`}>
                        {request.riskLevel}
                      </span>
                    </div>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                      {JSON.stringify(request.input || {}, null, 2)}
                    </pre>
                    {!sessionLabel ? (
                      <div className="mt-2 text-[11px] text-muted-foreground">Session {request.sessionId.slice(0, 12)}</div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenSession(request.sessionId)}
                      className="inline-flex h-8 items-center rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                    >
                      Open session
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleDecision(request.sessionId, request.requestId, false)}
                      className="inline-flex h-8 items-center rounded-lg border border-red-500/20 px-3 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Deny
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleDecision(request.sessionId, request.requestId, true)}
                      className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Allow
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
