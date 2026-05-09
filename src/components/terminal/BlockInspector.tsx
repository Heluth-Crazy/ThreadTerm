/**
 * BlockInspector — right-side metadata panel for the selected Command Block.
 *
 * Stage 6: the Explain button now invokes the real AI CLI via the
 * `ai_explain` Tauri command. The Q/A thread lives in `aiThreadStore` and
 * is rendered below the metadata/output sections. "Run as command" on an
 * AI answer requires a two-step confirm and is delegated to the caller
 * via `onRunCommand` (the caller is expected to inject the command into
 * the source card's PTY).
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, FolderOpen, Hash, Loader2, Sparkles, Timer, X } from 'lucide-react';
import type { Block } from '../../types/terminal';
import { explainWithAi, type AiExplainProvider } from '../../lib/ai/aiExplain';
import {
  getAiSessionExportFilename,
  renderAiSessionMarkdown,
  type AiSessionExportMessage,
} from '../../lib/ai/exportAiSession';
import { saveAiSessionMarkdownFile } from '../../lib/ai/tauriAiSessionExport';
import { useAiThreadStore, type AiThreadEntry } from '../../stores/aiThreadStore';
import { AiThreadView } from '../ai/AiThreadView';

/** Stable reference used by the Zustand selector fallback. */
const EMPTY_ENTRIES: AiThreadEntry[] = [];

export interface BlockInspectorProps {
  block: Block | null;
  /** When provided, renders a close button (X) in the panel header. */
  onClose?: () => void;
  /**
   * Provider to invoke when the user clicks Explain. If omitted, the
   * component falls back to `'claude'`. The caller (TerminalView) is
   * expected to resolve this from the focused card's `terminalType` or
   * the global `aiExplainDefaultProvider` setting.
   */
  providerOverride?: AiExplainProvider;
  /**
   * Handler invoked when the user confirms "Run as command" in an AI
   * answer. The caller is responsible for routing this to the block's
   * source card via `pty_input`.
   */
  onRunCommand?: (command: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function buildPrompt(block: Block): string {
  const output = block.output && block.output.length > 0 ? block.output : '(none)';
  const exitCode =
    block.exitCode === undefined || block.exitCode === null ? 'n/a' : String(block.exitCode);
  return [
    'Explain this command and its output:',
    '',
    `Command: ${block.command}`,
    `Cwd: ${block.cwd}`,
    `Exit code: ${exitCode}`,
    'Output:',
    output,
  ].join('\n');
}

function buildBlockContextMessage(block: Block): string {
  const exitCode =
    block.exitCode === undefined || block.exitCode === null ? 'n/a' : String(block.exitCode);
  return [
    'Block context:',
    '',
    block.command ? `Command: ${block.command}` : 'Command: Not available',
    `Cwd: ${block.cwd}`,
    `Exit code: ${exitCode}`,
  ].join('\n');
}

function buildExportMessages(
  block: Block,
  entries: AiThreadEntry[],
  provider: AiExplainProvider,
): AiSessionExportMessage[] {
  if (entries.length > 0) {
    return entries.map<AiSessionExportMessage>((entry) => ({
      id: entry.id,
      role: entry.role === 'user' ? 'user' : 'assistant',
      content: entry.text,
      provider: entry.provider,
      createdAt: entry.createdAt,
      state: entry.state,
    }));
  }

  const messages: AiSessionExportMessage[] = [
    {
      id: `${block.id}:context`,
      role: 'user',
      content: buildBlockContextMessage(block),
      createdAt: block.startedAt,
      state: 'ok',
    },
  ];

  if (block.output?.trim()) {
    messages.push({
      id: `${block.id}:output`,
      role: 'assistant',
      content: block.output,
      provider,
      createdAt: block.finishedAt ?? Date.now(),
      state: 'ok',
    });
  }

  return messages;
}

export function BlockInspector({
  block,
  onClose,
  providerOverride,
  onRunCommand,
}: BlockInspectorProps) {
  const { t } = useTranslation('terminal');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<'saved' | 'error' | null>(null);

  // Select only the thread for this block so we don't re-render when
  // unrelated threads change. The selector must return a stable reference
  // when entries are absent — a fresh `[]` would cause Zustand to report
  // a new value on every render and infinite-loop React.
  const thread = useAiThreadStore((s) => (block ? s.threads[block.id] : undefined));
  const entries = useMemo(() => thread?.entries ?? EMPTY_ENTRIES, [thread]);
  const appendQuestion = useAiThreadStore((s) => s.appendQuestion);
  const appendAnswer = useAiThreadStore((s) => s.appendAnswer);
  const setEntryState = useAiThreadStore((s) => s.setEntryState);

  const handleExplain = useCallback(async () => {
    if (!block) return;
    const provider = providerOverride ?? 'claude';
    const prompt = buildPrompt(block);
    const questionId = appendQuestion(block.id, prompt);
    setBusy(true);
    try {
      const result = await explainWithAi({ provider, prompt });
      setEntryState(block.id, questionId, 'ok');
      if (result.kind === 'ok') {
        const answer = result.text.trim();
        appendAnswer(
          block.id,
          answer || 'AI error: AI provider returned no answer.',
          provider,
          answer ? 'ok' : 'error',
        );
      } else {
        appendAnswer(
          block.id,
          t('aiThread.error', {
            message: result.message,
            defaultValue: `AI error: ${result.message}`,
          }),
          provider,
          'error',
        );
      }
    } finally {
      setBusy(false);
    }
  }, [block, providerOverride, appendQuestion, appendAnswer, setEntryState, t]);

  const handleRunCommand = useCallback(
    (command: string) => {
      onRunCommand?.(command);
    },
    [onRunCommand],
  );

  const handleExport = useCallback(async () => {
    if (!block) return;
    const liveEntries = useAiThreadStore.getState().threads[block.id]?.entries ?? entries;
    const provider =
      providerOverride ?? liveEntries.find((entry) => entry.provider)?.provider ?? 'claude';
    const messages = buildExportMessages(block, liveEntries, provider);
    const source = {
      userIntent: 'explain',
      provider,
      sessionId: `block:${block.id}`,
      startedAt: messages[0]?.createdAt ?? block.startedAt,
      endedAt: messages[messages.length - 1]?.createdAt ?? block.finishedAt ?? Date.now(),
      sourceContext: {
        kind: 'block' as const,
        cardId: block.cardId,
        blockId: block.id,
        cwd: block.cwd,
        command: block.command,
      },
      messages,
    };

    setExporting(true);
    setExportStatus(null);
    try {
      const result = await saveAiSessionMarkdownFile(
        renderAiSessionMarkdown(source),
        getAiSessionExportFilename(source),
        {
          title: t('aiExport.dialogTitle', { defaultValue: 'Export AI session Markdown' }),
          filterName: t('aiExport.markdownFilter', { defaultValue: 'Markdown' }),
        },
      );
      if (result.kind === 'saved') {
        setExportStatus('saved');
      }
    } catch {
      setExportStatus('error');
    } finally {
      setExporting(false);
    }
  }, [block, entries, providerOverride]);

  if (!block) return null;

  const isRunning = block.state === 'running';
  const exitCodeLabel =
    block.exitCode !== undefined && block.exitCode !== null ? String(block.exitCode) : '—';
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
            className="max-h-48 overflow-y-auto rounded-[var(--radius-md)] border border-white/10 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all"
          >
            {block.output}
          </pre>
        </div>
      )}

      {/* AI Explain button + thread */}
      <div className="mt-auto flex flex-col gap-2 pt-2">
        <button
          type="button"
          data-testid="block-inspector-explain"
          onClick={handleExplain}
          disabled={busy}
          className="flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-white/10 bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-wait disabled:opacity-60"
          title={t('block.explain', { defaultValue: 'Explain with AI' })}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {t('block.explain', { defaultValue: 'Explain with AI' })}
        </button>
        <AiThreadView
          entries={entries}
          onRunCommand={handleRunCommand}
          onExport={handleExport}
          exporting={exporting}
          exportStatus={exportStatus}
        />
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
