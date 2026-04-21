import type { AttentionItem } from '../../stores/attentionStore';
import { acknowledgeAttentionItem } from '../../lib/attention-actions';
import type { InboxSessionLabel } from './ApprovalInbox';

interface AttentionInboxProps {
  items: AttentionItem[];
  onOpenSession: (sessionId: string) => void;
  sessionLabels?: Record<string, InboxSessionLabel>;
}

const RISK_TONE: Record<AttentionItem['riskLevel'], string> = {
  low: 'text-slate-500 bg-slate-500/10',
  medium: 'text-amber-600 bg-amber-500/10',
  high: 'text-red-500 bg-red-500/10',
};

export default function AttentionInbox({ items, onOpenSession, sessionLabels = {} }: AttentionInboxProps) {
  return (
    <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Attention Inbox</h2>
          <p className="text-xs text-muted-foreground">Active runtime events that need review, recovery, or a quick check.</p>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 ? (
            <button
              type="button"
              onClick={() => onOpenSession(items[0].sessionId)}
              className="inline-flex h-8 items-center rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              Review next
            </button>
          ) : null}
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{items.length}</span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-6 text-sm text-muted-foreground">
          No active attention items.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const sessionLabel = sessionLabels[item.sessionId];

            return (
              <div key={item.id} className="rounded-xl border border-border/60 bg-background/70 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {sessionLabel ? (
                      <div className="mb-2">
                        <div className="truncate text-xs font-medium text-foreground">{sessionLabel.title}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{sessionLabel.subtitle}</div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{item.title}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RISK_TONE[item.riskLevel]}`}>
                        {item.riskLevel}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {item.reason}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{item.message || 'No extra context attached yet.'}</p>
                    {!sessionLabel ? (
                      <div className="mt-2 text-[11px] text-muted-foreground">Session {item.sessionId.slice(0, 12)}</div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => acknowledgeAttentionItem(item.id)}
                      className="inline-flex h-8 items-center rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                    >
                      Mark reviewed
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenSession(item.sessionId)}
                      className="inline-flex h-8 items-center rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                    >
                      Open session
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
