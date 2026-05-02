/**
 * BlockToolbar — inline action bar shown on hover over a block header.
 *
 * Actions: Copy command · Copy output · Copy both · Re-run · Collapse/Expand ·
 * Explain (AI, Stage 6 placeholder).
 *
 * Re-run is hidden for blocks still in `running` state to prevent
 * duplicate execution.
 *
 * Callers are responsible for wiring clipboard / PTY calls; this component
 * only fires callbacks.
 */
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ClipboardCopy, Play, Sparkles, Star, Terminal } from 'lucide-react';
import type { Block } from '../../types/terminal';

export interface BlockToolbarProps {
  block: Block;
  collapsed: boolean;
  /** When true, the re-run button is "armed" — the next click executes. */
  rerunPending?: boolean;
  /** Stage 5 — block-level bookmark state. When `onToggleBookmark` is
   *  omitted, the bookmark button is not rendered (e.g. tests / minimal
   *  hosts that don't wire bookmark plumbing). */
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
  onCopyCommand: () => void;
  onCopyOutput: () => void;
  onCopyBoth: () => void;
  onRerun: (command: string) => void;
  onToggleCollapse: () => void;
  onExplain: () => void;
}

export function BlockToolbar({
  block,
  collapsed,
  rerunPending = false,
  bookmarked = false,
  onToggleBookmark,
  onCopyCommand,
  onCopyOutput,
  onCopyBoth,
  onRerun,
  onToggleCollapse,
  onExplain,
}: BlockToolbarProps) {
  const { t } = useTranslation('terminal');

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-background/95 px-1 py-0.5 shadow-md backdrop-blur-sm">
      {/* Copy command */}
      <ActionBtn
        testId="block-copy-command"
        title={t('block.copyCommand', { defaultValue: 'Copy command' })}
        onClick={onCopyCommand}
      >
        <Terminal className="h-3 w-3" />
      </ActionBtn>

      {/* Copy output */}
      <ActionBtn
        testId="block-copy-output"
        title={t('block.copyOutput', { defaultValue: 'Copy output' })}
        onClick={onCopyOutput}
      >
        <ClipboardCopy className="h-3 w-3" />
      </ActionBtn>

      {/* Copy both */}
      <ActionBtn
        testId="block-copy-both"
        title={t('block.copyBoth', { defaultValue: 'Copy command + output' })}
        onClick={onCopyBoth}
      >
        <span className="text-[9px] font-bold leading-none">⊕</span>
      </ActionBtn>

      <div className="mx-0.5 h-3.5 w-px bg-border" />

      {/* Re-run — hidden while the block is still running. When `rerunPending`
          is true the button is "armed": next click executes, otherwise the
          first click only arms it (auto-disarms after 1.5s in BlockOverlay). */}
      {block.state !== 'running' && (
        <ActionBtn
          testId="block-rerun"
          title={
            rerunPending
              ? t('block.rerunConfirm', { defaultValue: 'Click again to re-run' })
              : t('block.rerun', { defaultValue: 'Re-run command' })
          }
          data-pending={rerunPending ? 'true' : 'false'}
          onClick={() => onRerun(block.command)}
        >
          <Play className={['h-3 w-3', rerunPending ? 'text-amber-500' : ''].join(' ')} />
        </ActionBtn>
      )}

      {/* Collapse / Expand */}
      <ActionBtn
        testId="block-collapse-btn"
        title={
          collapsed
            ? t('block.expand', { defaultValue: 'Expand block' })
            : t('block.collapse', { defaultValue: 'Collapse block' })
        }
        data-collapsed={collapsed ? 'true' : 'false'}
        onClick={onToggleCollapse}
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </ActionBtn>

      <div className="mx-0.5 h-3.5 w-px bg-border" />

      {/* Explain (AI) — Stage 6 placeholder */}
      <ActionBtn
        testId="block-explain"
        title={t('block.explain', { defaultValue: 'Explain with AI' })}
        onClick={onExplain}
      >
        <Sparkles className="h-3 w-3" />
      </ActionBtn>

      {/* Bookmark — Stage 5. Omitted when host does not wire onToggleBookmark. */}
      {onToggleBookmark && (
        <ActionBtn
          testId="block-bookmark"
          title={
            bookmarked
              ? t('block.unbookmark', { defaultValue: 'Remove bookmark' })
              : t('block.bookmark', { defaultValue: 'Bookmark this block' })
          }
          data-bookmarked={bookmarked ? 'true' : 'false'}
          onClick={onToggleBookmark}
        >
          <Star
            className={[
              'h-3 w-3',
              bookmarked ? 'fill-amber-400 text-amber-400' : '',
            ].join(' ')}
          />
        </ActionBtn>
      )}
    </div>
  );
}

interface ActionBtnProps {
  testId: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  [key: string]: unknown;
}

function ActionBtn({ testId, title, onClick, children, ...rest }: ActionBtnProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      {...rest}
    >
      {children}
    </button>
  );
}
