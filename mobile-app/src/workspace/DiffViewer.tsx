import { useMemo } from 'react';
import type { DiffViewMode, DiffViewerModel } from './types';
import { useI18n } from '../i18n';

export interface DiffViewerProps {
  model: DiffViewerModel;
  onModeChange: (mode: DiffViewMode) => void;
  /** Prefer dual column when viewport is wide (tablet). */
  dualColumn?: boolean;
}

export function DiffViewer({ model, onModeChange, dualColumn = false }: DiffViewerProps) {
  const { language } = useI18n();
  const zh = language === 'zh';

  const body = useMemo(() => {
    switch (model.mode) {
      case 'original':
        return model.original;
      case 'current':
        return model.current;
      case 'diff':
      default:
        return model.diffText || buildSimpleDiff(model.original, model.current);
    }
  }, [model]);

  const modes: DiffViewMode[] = ['original', 'current', 'diff'];
  const modeLabels: Record<DiffViewMode, string> = {
    original: zh ? '原始' : 'Original',
    current: zh ? '当前' : 'Current',
    diff: zh ? '差异' : 'Diff',
  };

  return (
    <div
      className={`diff-viewer ${dualColumn && model.mode === 'diff' ? 'dual' : 'single'}`}
      data-testid="diff-viewer"
    >
      <header className="diff-viewer-toolbar">
        <div className="file-editor-title">
          <strong>{model.title}</strong>
          <small className="breakable-path">{model.relativePath}</small>
        </div>
        <div className="segmented diff-mode-segmented" role="tablist" aria-label={zh ? 'Diff 视图' : 'Diff view'}>
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              className={model.mode === mode ? 'segmented-active' : ''}
              aria-pressed={model.mode === mode}
              onClick={() => onModeChange(mode)}
              data-testid={`diff-mode-${mode}`}
            >
              {modeLabels[mode]}
            </button>
          ))}
        </div>
      </header>
      {dualColumn && model.mode === 'diff' ? (
        <div className="diff-dual-columns">
          <pre className="diff-pane" data-testid="diff-original-pane">{model.original}</pre>
          <pre className="diff-pane" data-testid="diff-current-pane">{model.current}</pre>
        </div>
      ) : (
        <pre className="diff-pane single" data-testid="diff-body">
          {body}
        </pre>
      )}
      {model.readOnly && (
        <p className="file-editor-pill diff-readonly" data-testid="diff-readonly">
          {zh ? '只读 Diff' : 'Read-only diff'}
        </p>
      )}
    </div>
  );
}

/** Minimal line-oriented diff for offline/UI preview; desktop is authoritative. */
export function buildSimpleDiff(original: string, current: string): string {
  const a = original.split('\n');
  const b = current.split('\n');
  const max = Math.max(a.length, b.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      if (left !== undefined) lines.push(`  ${left}`);
    } else {
      if (left !== undefined) lines.push(`- ${left}`);
      if (right !== undefined) lines.push(`+ ${right}`);
    }
  }
  return lines.join('\n');
}
