import { memo } from 'react';
import {
  Bot,
  Brain,
  Check,
  Loader2,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  stringifyClaudeValue,
  type ClaudeDisplayItem,
} from '../../lib/claudeChat/normalize';
import type { PendingClaudeRequest } from '../../stores/claudeChatStore';

export const ClaudeItemRow = memo(function ClaudeItemRow({
  item,
}: {
  item: ClaudeDisplayItem;
}) {
  const { t } = useTranslation('terminal');
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground">
          {item.body}
        </div>
      </div>
    );
  }

  if (item.kind === 'thinking') {
    return (
      <details className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground/80">
          <Brain className="h-3.5 w-3.5" />
          {t('claudeChat.thinking', { defaultValue: 'Thinking' })}
        </summary>
        <div className="mt-2 whitespace-pre-wrap border-t border-border pt-2 leading-5">
          {item.body}
        </div>
      </details>
    );
  }

  if (item.kind === 'tool') {
    return (
      <div className="rounded-md border border-border bg-muted/20">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <Wrench className="h-3.5 w-3.5 shrink-0 text-orange-400" />
            <span className="truncate">{item.title}</span>
          </span>
          {item.status && (
            <span
              className={
                item.status === 'error'
                  ? 'text-destructive'
                  : item.status === 'ok'
                    ? 'text-emerald-400'
                    : 'text-muted-foreground'
              }
            >
              {item.status}
            </span>
          )}
        </div>
        {item.body && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
            {item.body}
          </pre>
        )}
      </div>
    );
  }

  if (item.kind === 'system' || item.kind === 'result') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
        {item.status === 'error' ? (
          <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
        )}
        <div className="min-w-0">
          <div className="font-medium text-foreground/80">{item.title}</div>
          {item.body && (
            <div className="mt-0.5 whitespace-pre-wrap">{item.body}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-orange-500/10 text-orange-400">
        {item.status === 'streaming' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Bot className="h-3.5 w-3.5" />
        )}
      </div>
      <div className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-6">
        {item.body ||
          t('claudeChat.responding', {
            defaultValue: 'Claude is responding…',
          })}
      </div>
    </div>
  );
});

export function ClaudeApprovalCard({
  request,
  resolving,
  onAllow,
  onDeny,
}: {
  request: PendingClaudeRequest;
  resolving: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation('terminal');
  return (
    <div className="rounded-md border border-amber-500/30 bg-background px-3 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {t('claudeChat.approvalTitle', {
                defaultValue: 'Claude needs permission',
              })}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {request.toolName ?? request.kind}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onDeny}
            disabled={resolving}
            className="inline-flex h-7 items-center rounded-md border border-border px-3 text-xs hover:bg-accent disabled:opacity-50"
          >
            {t('claudeChat.deny', { defaultValue: 'Deny' })}
          </button>
          <button
            type="button"
            onClick={onAllow}
            disabled={resolving}
            className="inline-flex h-7 items-center rounded-md bg-amber-500 px-3 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
          >
            {resolving && (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            )}
            {t('claudeChat.allow', { defaultValue: 'Allow' })}
          </button>
        </div>
      </div>
      {request.input !== undefined && (
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
          {stringifyClaudeValue(request.input)}
        </pre>
      )}
    </div>
  );
}
