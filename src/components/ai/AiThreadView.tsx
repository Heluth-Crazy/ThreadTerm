/**
 * AiThreadView — presentational list of Q/A entries for a block.
 *
 * Stage 6 design:
 *   • Stateless: all data is passed in via `entries`.
 *   • Run-as-command uses the same two-step confirm pattern as the
 *     re-run button in BlockToolbar: first click flips a `data-pending`
 *     visual + 1.5s timer, second click within the window invokes the
 *     provided `onRunCommand` callback.
 *   • Fenced code blocks / inline backticks in an AI answer are parsed
 *     out and offered as the runnable text.
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { Bot, Download, Loader2, Play, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AiThreadEntry } from '../../stores/aiThreadStore';

const RERUN_CONFIRM_MS = 1500;
const FENCE_RE = /```(?:\w+)?\n([\s\S]+?)\n```|`([^`\n]+)`/m;

function extractFirstCommand(text: string): string | null {
  const m = text.match(FENCE_RE);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim() || null;
}

interface Props {
  entries: AiThreadEntry[];
  onRunCommand: (command: string) => void;
  onExport?: () => void;
  exporting?: boolean;
  exportStatus?: 'saved' | 'error' | null;
}

export function AiThreadView({
  entries,
  onRunCommand,
  onExport,
  exporting = false,
  exportStatus = null,
}: Props) {
  const { t } = useTranslation('terminal');
  const exportActionLabel = t('aiExport.exportMarkdown', { defaultValue: 'Export AI Markdown' });
  const exportStatusLabel =
    exportStatus === 'saved'
      ? t('aiExport.saved', { defaultValue: 'AI session Markdown exported.' })
      : exportStatus === 'error'
        ? t('aiExport.failed', { defaultValue: 'AI session export failed.' })
        : null;

  if (entries.length === 0) {
    return (
      <div className="flex items-center gap-1">
        <div data-testid="ai-thread-empty" className="min-w-0 flex-1 text-[10px] text-muted-foreground italic">
          {t('aiThread.empty', { defaultValue: 'Ask AI to explain — answers appear here.' })}
        </div>
        {onExport && (
          <button
            type="button"
            data-testid="ai-thread-export"
            onClick={onExport}
            disabled={exporting}
            title={exportActionLabel}
            aria-label={exportActionLabel}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-wait disabled:opacity-50"
          >
            {exporting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {exportStatusLabel && (
              <span className="sr-only" role="status" aria-live="polite">
                {exportStatusLabel}
              </span>
            )}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {onExport && (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="ai-thread-export"
            onClick={onExport}
            disabled={exporting}
            title={exportActionLabel}
            aria-label={exportActionLabel}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-wait disabled:opacity-50"
          >
            {exporting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {exportStatusLabel && (
              <span className="sr-only" role="status" aria-live="polite">
                {exportStatusLabel}
              </span>
            )}
          </button>
        </div>
      )}
      {entries.map((e) => (
        <Entry key={e.id} entry={e} onRunCommand={onRunCommand} />
      ))}
    </div>
  );
}

function Entry({ entry, onRunCommand }: { entry: AiThreadEntry; onRunCommand: (c: string) => void }) {
  const { t } = useTranslation('terminal');
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmd = useMemo(() => (entry.role === 'ai' ? extractFirstCommand(entry.text) : null), [entry]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClickRun = () => {
    if (!cmd) return;
    if (!pending) {
      setPending(true);
      timer.current = setTimeout(() => setPending(false), RERUN_CONFIRM_MS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setPending(false);
    onRunCommand(cmd);
  };

  return (
    <div
      data-testid={`ai-thread-entry-${entry.id}`}
      data-role={entry.role}
      className={
        entry.role === 'user'
          ? 'rounded-md border border-border bg-muted/30 p-2 text-[11px]'
          : 'rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-[11px]'
      }
    >
      <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {entry.role === 'user' ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
        <span>{entry.role === 'user' ? 'You' : `AI · ${entry.provider ?? 'unknown'}`}</span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">
        {entry.state === 'pending' ? '…' : entry.text}
      </pre>
      {cmd && entry.state === 'ok' && (
        <button
          type="button"
          data-testid={`ai-run-as-command-${entry.id}`}
          data-pending={pending ? 'true' : 'false'}
          onClick={onClickRun}
          className={
            'mt-1 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ' +
            (pending
              ? 'bg-amber-500/20 text-amber-600'
              : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground')
          }
        >
          <Play className="h-3 w-3" />
          {pending
            ? t('aiThread.runAsCommandConfirm', { defaultValue: 'Click again to run' })
            : t('aiThread.runAsCommand', { defaultValue: 'Run as command' })}
        </button>
      )}
    </div>
  );
}
