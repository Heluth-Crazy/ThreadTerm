/**
 * BlockInspector — right-side metadata panel for the selected Command Block.
 *
 * Renders: command, cwd, exit code, duration, state indicator, AI Explain
 * placeholder. Returns null when no block is selected.
 *
 * Stage 4 spec: reuse headlessPreview.ts for plain-text extraction; no
 * new markdown parser.
 */
import { useTranslation } from 'react-i18next';
import { Cpu, FolderOpen, Hash, Loader2, Sparkles, Timer, X } from 'lucide-react';
import type { Block } from '../../types/terminal';

export interface BlockInspectorProps {
  block: Block | null;
  /** When provided, renders a close button (X) in the panel header. */
  onClose?: () => void;
  /** Stage 6 placeholder; Stage 4.3 ships an inert click handler that just
   *  calls this if provided. Real AI invocation lands in Stage 6. */
  onExplain?: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

export function BlockInspector({ block, onClose, onExplain }: BlockInspectorProps) {
  const { t } = useTranslation('terminal');

  if (!block) return null;

  const isRunning = block.state === 'running';
  const exitCodeLabel =
    block.exitCode !== undefined && block.exitCode !== null
      ? String(block.exitCode)
      : '—';
  const closeLabel = t('common.close', { defaultValue: 'Close' });

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      <div className="flex items-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>{t('block.inspector.title', { defaultValue: 'Block Inspector' })}</span>
        {onClose && (
          <button
            type="button"
            data-testid="block-inspector-close"
            onClick={onClose}
            title={closeLabel}
            aria-label={closeLabel}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Command */}
      <Row icon={<Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />} label={t('block.inspector.command', { defaultValue: 'Command' })}>
        <code className="break-all font-mono text-[11px]">{block.command}</code>
      </Row>

      {/* Working directory */}
      <Row icon={<FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />} label={t('block.inspector.cwd', { defaultValue: 'Directory' })}>
        <span className="break-all font-mono text-[11px]">{block.cwd}</span>
      </Row>

      {/* Exit code */}
      <Row icon={<Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />} label={t('block.inspector.exitCode', { defaultValue: 'Exit code' })}>
        {isRunning ? (
          <span data-testid="block-inspector-running" className="flex items-center gap-1 text-amber-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('block.inspector.running', { defaultValue: 'Running…' })}
          </span>
        ) : (
          <span
            className={
              block.exitCode === 0
                ? 'text-green-500'
                : block.exitCode !== undefined && block.exitCode !== null
                  ? 'text-red-500'
                  : 'text-muted-foreground'
            }
          >
            {exitCodeLabel}
          </span>
        )}
      </Row>

      {/* Duration */}
      {block.durationMs !== undefined && block.durationMs !== null && (
        <Row icon={<Timer className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />} label={t('block.inspector.duration', { defaultValue: 'Duration' })}>
          <span>{formatDuration(block.durationMs)}</span>
        </Row>
      )}

      {/* Plain-text output (Stage 4.3) */}
      {block.output && block.output.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] text-muted-foreground">
            {t('block.inspector.output', { defaultValue: 'Output' })}
          </div>
          <pre
            data-testid="block-inspector-output"
            className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all"
          >
            {block.output}
          </pre>
        </div>
      )}

      {/* AI Explain placeholder */}
      <div className="mt-auto pt-2">
        <button
          type="button"
          data-testid="block-inspector-explain"
          onClick={onExplain}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={t('block.inspector.explainPlaceholder', {
            defaultValue: 'Explain with AI (coming in Stage 6)',
          })}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t('block.explain', { defaultValue: 'Explain with AI' })}
        </button>
      </div>
    </div>
  );
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}

function Row({ icon, label, children }: RowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="pl-5">{children}</div>
    </div>
  );
}
