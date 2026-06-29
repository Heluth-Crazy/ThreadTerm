import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, {
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror';
import { EditorState, Text, type Extension } from '@codemirror/state';
import {
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  type ViewUpdate,
} from '@codemirror/view';
import { MergeView, type Chunk } from '@codemirror/merge';
import { cn } from '../../lib/utils';

const SYNTAX_HIGHLIGHT_MAX_BYTES = 512 * 1024;

export interface WorkspaceCodeEditorProps {
  value: string;
  path: string;
  active: boolean;
  readOnly?: boolean;
  className?: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
}

export interface WorkspaceMergeDiffEditorLabels {
  editableDiff: string;
  readOnlyDiff: string;
  editLine: string;
  revertLine: string;
  revertHunk: string;
  revertedLine: string;
  revertedHunk: string;
  revertedHunkFallback: string;
}

export interface WorkspaceMergeDiffEditorProps {
  path: string;
  baseValue: string;
  currentValue: string;
  editable: boolean;
  active: boolean;
  className?: string;
  labels: WorkspaceMergeDiffEditorLabels;
  onCurrentChange?: (value: string) => void;
  onSave?: () => void;
  onStatus?: (message: string) => void;
}

const codeEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'transparent',
      color: 'hsl(var(--foreground))',
      fontSize: '12px',
    },
    '.cm-scroller': {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      lineHeight: '1.6',
    },
    '.cm-content': {
      caretColor: 'hsl(var(--foreground))',
      minHeight: '100%',
      padding: '12px 0',
    },
    '.cm-line': {
      padding: '0 12px',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      borderRight: '1px solid hsl(var(--border) / 0.55)',
      color: 'hsl(var(--muted-foreground) / 0.65)',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
      backgroundColor: 'hsl(var(--accent) / 0.45)',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'hsl(var(--primary) / 0.28)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor': {
      borderLeftColor: 'hsl(var(--foreground))',
    },
    '.cm-searchMatch': {
      backgroundColor: 'hsl(45 93% 47% / 0.28)',
    },
  },
  { dark: true },
);

export function WorkspaceCodeEditor({
  value,
  path,
  active,
  readOnly = false,
  className,
  onChange,
  onSave,
}: WorkspaceCodeEditorProps) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const languageExtensions = useLanguageExtensions(path, value);
  const saveRef = useRef(onSave);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (active) {
      editorRef.current?.view?.focus();
    }
  }, [active]);

  const extensions = useMemo(
    () => [
      codeEditorTheme,
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            saveRef.current?.();
            return true;
          },
        },
      ]),
      ...languageExtensions,
    ],
    [languageExtensions],
  );

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      height="100%"
      theme="none"
      basicSetup={{
        bracketMatching: true,
        closeBrackets: true,
        foldGutter: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        lineNumbers: true,
      }}
      extensions={extensions}
      readOnly={readOnly}
      editable={!readOnly}
      indentWithTab
      onChange={(nextValue) => onChange?.(nextValue)}
      className={cn('min-h-0 flex-1 overflow-hidden', className)}
    />
  );
}

export function WorkspaceMergeDiffEditor({
  path,
  baseValue,
  currentValue,
  editable,
  active,
  className,
  labels,
  onCurrentChange,
  onSave,
  onStatus,
}: WorkspaceMergeDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const currentChangeRef = useRef(onCurrentChange);
  const saveRef = useRef(onSave);
  const statusRef = useRef(onStatus);
  const languageExtensions = useLanguageExtensions(path, currentValue);

  useEffect(() => {
    currentChangeRef.current = onCurrentChange;
  }, [onCurrentChange]);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    statusRef.current = onStatus;
  }, [onStatus]);

  const revertLine = useCallback(
    (lineNumber?: number) => {
      const mergeView = mergeRef.current;
      if (!mergeView) return false;
      const currentView = mergeView.b;
      const targetLine =
        lineNumber ?? currentView.state.doc.lineAt(currentView.state.selection.main.head).number;
      const reverted = revertCurrentLine(mergeView, targetLine);
      if (reverted === 'line') {
        statusRef.current?.(labels.revertedLine);
        return true;
      }
      if (reverted === 'hunk') {
        statusRef.current?.(labels.revertedHunkFallback);
        return true;
      }
      return false;
    },
    [labels.revertedHunkFallback, labels.revertedLine],
  );

  const revertHunk = useCallback(() => {
    const mergeView = mergeRef.current;
    if (!mergeView) return false;
    const reverted = revertCurrentHunk(mergeView);
    if (reverted) {
      statusRef.current?.(labels.revertedHunk);
    }
    return reverted;
  }, [labels.revertedHunk]);

  const focusCurrentEditor = useCallback(() => {
    mergeRef.current?.b.focus();
  }, []);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    parent.innerHTML = '';

    const baseExtensions: Extension[] = [
      codeEditorTheme,
      EditorView.lineWrapping,
      editable ? createDiffLineActionPlaceholderGutter() : [],
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      ...languageExtensions,
    ];
    const currentExtensions: Extension[] = [
      codeEditorTheme,
      EditorView.lineWrapping,
      editable ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)],
      editable ? createDiffLineActionGutter(() => mergeRef.current, revertLine, labels.revertLine) : [],
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            saveRef.current?.();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          currentChangeRef.current?.(update.state.doc.toString());
        }
      }),
      ...languageExtensions,
    ];

    const mergeView = new MergeView({
      a: {
        doc: baseValue,
        extensions: baseExtensions,
      },
      b: {
        doc: currentValue,
        extensions: currentExtensions,
      },
      parent,
      orientation: 'a-b',
      revertControls: editable ? 'a-to-b' : undefined,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: {
        margin: 4,
        minSize: 10,
      },
      diffConfig: {
        scanLimit: 800,
        timeout: 800,
      },
    });

    mergeView.dom.classList.add('threadterm-merge-view');
    mergeRef.current = mergeView;
    mergeView.b.dispatch({});

    const win = mergeView.dom.ownerDocument.defaultView ?? window;
    let measureFrame: number | null = null;
    const scheduleMergeMeasure = () => {
      if (measureFrame !== null) return;
      measureFrame = win.requestAnimationFrame(() => {
        measureFrame = null;
        mergeView.a.requestMeasure();
        mergeView.b.requestMeasure();
      });
    };
    const handleMergeScroll = () => {
      scheduleMergeMeasure();
    };
    const handleCollapsedClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.cm-collapsedLines')) {
        scheduleMergeMeasure();
      }
    };

    mergeView.dom.addEventListener('scroll', handleMergeScroll, { passive: true });
    mergeView.dom.addEventListener('click', handleCollapsedClick);
    scheduleMergeMeasure();

    return () => {
      mergeView.dom.removeEventListener('scroll', handleMergeScroll);
      mergeView.dom.removeEventListener('click', handleCollapsedClick);
      if (measureFrame !== null) {
        win.cancelAnimationFrame(measureFrame);
      }
      mergeRef.current = null;
      mergeView.destroy();
      parent.innerHTML = '';
    };
  }, [baseValue, editable, labels.revertLine, languageExtensions, revertLine]);

  useEffect(() => {
    if (active && editable) {
      mergeRef.current?.b.focus();
    }
  }, [active, editable]);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', className)}>
      <div className="flex min-h-[32px] items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="mr-auto">
          {editable ? labels.editableDiff : labels.readOnlyDiff}
        </span>
        {editable && (
          <>
            <button
              type="button"
              onClick={focusCurrentEditor}
              className="rounded px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
            >
              {labels.editLine}
            </button>
            <button
              type="button"
              onClick={() => revertLine()}
              className="rounded px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
            >
              {labels.revertLine}
            </button>
            <button
              type="button"
              onClick={revertHunk}
              className="rounded px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
            >
              {labels.revertHunk}
            </button>
          </>
        )}
      </div>
      <div ref={containerRef} className="threadterm-merge-host min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

function useLanguageExtensions(path: string, value: string): Extension[] {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const shouldHighlight = textByteLength(value) <= SYNTAX_HIGHLIGHT_MAX_BYTES;

  useEffect(() => {
    let cancelled = false;
    if (!shouldHighlight) {
      setExtensions([]);
      return () => {
        cancelled = true;
      };
    }

    void loadLanguageExtensions(path)
      .then((nextExtensions) => {
        if (!cancelled) setExtensions(nextExtensions);
      })
      .catch(() => {
        if (!cancelled) setExtensions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [path, shouldHighlight]);

  return extensions;
}

async function loadLanguageExtensions(path: string): Promise<Extension[]> {
  const lower = path.toLowerCase();
  if (/\.(tsx|ts|mts|cts)$/.test(lower)) {
    const { javascript } = await import('@codemirror/lang-javascript');
    return [javascript({ jsx: lower.endsWith('x'), typescript: true })];
  }
  if (/\.(jsx|js|mjs|cjs)$/.test(lower)) {
    const { javascript } = await import('@codemirror/lang-javascript');
    return [javascript({ jsx: lower.endsWith('x') })];
  }
  if (/\.(json|jsonc)$/.test(lower)) {
    const { json } = await import('@codemirror/lang-json');
    return [json()];
  }
  if (/\.(md|mdx|markdown)$/.test(lower)) {
    const { markdown } = await import('@codemirror/lang-markdown');
    return [markdown()];
  }
  if (/\.(css|scss|sass|less)$/.test(lower)) {
    const { css } = await import('@codemirror/lang-css');
    return [css()];
  }
  if (/\.(html|htm|xml|svg)$/.test(lower)) {
    const { html } = await import('@codemirror/lang-html');
    return [html()];
  }
  if (lower.endsWith('.rs')) {
    const { rust } = await import('@codemirror/lang-rust');
    return [rust()];
  }
  if (/\.(py|pyw)$/.test(lower)) {
    const { python } = await import('@codemirror/lang-python');
    return [python()];
  }
  if (/\.(ya?ml)$/.test(lower)) {
    const { yaml } = await import('@codemirror/lang-yaml');
    return [yaml()];
  }
  return [];
}

class DiffLineActionMarker extends GutterMarker {
  constructor(
    private readonly lineNumber: number,
    private readonly onRevertLine: (lineNumber: number) => boolean,
    private readonly label: string,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof DiffLineActionMarker &&
      other.lineNumber === this.lineNumber &&
      other.label === this.label
    );
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'R';
    button.title = this.label;
    button.setAttribute('aria-label', this.label);
    button.className = 'cm-diff-line-action-button';
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onRevertLine(this.lineNumber);
    });
    return button;
  }
}

class DiffLineActionSpacerMarker extends GutterMarker {
  eq(other: GutterMarker): boolean {
    return other instanceof DiffLineActionSpacerMarker;
  }

  toDOM(): HTMLElement {
    const spacer = document.createElement('span');
    spacer.textContent = 'R';
    spacer.className = 'cm-diff-line-action-button cm-diff-line-action-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    return spacer;
  }
}

const diffLineActionSpacerMarker = new DiffLineActionSpacerMarker();

function createDiffLineActionPlaceholderGutter(): Extension {
  return gutter({
    class: 'cm-diff-line-actions cm-diff-line-actions-placeholder',
    initialSpacer: () => diffLineActionSpacerMarker,
  });
}

function createDiffLineActionGutter(
  getMergeView: () => MergeView | null,
  onRevertLine: (lineNumber: number) => boolean,
  label: string,
): Extension {
  return gutter({
    class: 'cm-diff-line-actions',
    lineMarker(view, line) {
      const mergeView = getMergeView();
      if (!mergeView || mergeView.b !== view) return null;
      const lineNumber = view.state.doc.lineAt(line.from).number;
      return isCurrentLineInChangedChunk(mergeView.chunks, view.state.doc, lineNumber)
        ? new DiffLineActionMarker(lineNumber, onRevertLine, label)
        : null;
    },
  });
}

function isCurrentLineInChangedChunk(chunks: readonly Chunk[], doc: Text, lineNumber: number): boolean {
  const line = doc.line(lineNumber);
  return chunks.some((chunk) => {
    if (chunk.fromB === chunk.toB) return false;
    return line.from >= chunk.fromB && line.from <= chunk.endB;
  });
}

type RevertResult = 'line' | 'hunk' | 'none';

function revertCurrentLine(mergeView: MergeView, lineNumber: number): RevertResult {
  const currentView = mergeView.b;
  const currentDoc = currentView.state.doc;
  if (lineNumber < 1 || lineNumber > currentDoc.lines) return 'none';

  const currentLine = currentDoc.line(lineNumber);
  const chunk = mergeView.chunks.find((candidate) => {
    if (candidate.fromB === candidate.toB) return false;
    return currentLine.from >= candidate.fromB && currentLine.from <= candidate.endB;
  });
  if (!chunk) return 'none';

  const baseDoc = mergeView.a.state.doc;
  const currentStartLine = currentDoc.lineAt(clampPosition(chunk.fromB, currentDoc)).number;
  const currentEndLine = currentDoc.lineAt(clampPosition(chunk.endB, currentDoc)).number;
  const currentLineCount = currentEndLine - currentStartLine + 1;
  const baseLineCount =
    chunk.fromA === chunk.toA
      ? 0
      : baseDoc.lineAt(clampPosition(chunk.endA, baseDoc)).number -
        baseDoc.lineAt(clampPosition(chunk.fromA, baseDoc)).number +
        1;
  const offset = lineNumber - currentStartLine;

  if (baseLineCount === 0) {
    currentView.dispatch({
      changes: deleteLineChange(currentDoc, currentLine),
    });
    return 'line';
  }

  if (offset < baseLineCount && offset < currentLineCount) {
    const baseStartLine = baseDoc.lineAt(clampPosition(chunk.fromA, baseDoc)).number;
    const baseLine = baseDoc.line(baseStartLine + offset);
    currentView.dispatch({
      changes: {
        from: currentLine.from,
        to: currentLine.to,
        insert: baseLine.text,
      },
    });
    return 'line';
  }

  return revertCurrentHunk(mergeView, chunk) ? 'hunk' : 'none';
}

function revertCurrentHunk(mergeView: MergeView, preferredChunk?: Chunk): boolean {
  const currentView = mergeView.b;
  const currentDoc = currentView.state.doc;
  const head = currentView.state.selection.main.head;
  const chunk =
    preferredChunk ??
    mergeView.chunks.find((candidate) => {
      if (candidate.fromB === candidate.toB) {
        return head >= candidate.fromB - 1 && head <= candidate.fromB + 1;
      }
      return head >= candidate.fromB && head <= candidate.endB;
    });
  if (!chunk) return false;

  const baseDoc = mergeView.a.state.doc;
  currentView.dispatch({
    changes: {
      from: clampPosition(chunk.fromB, currentDoc),
      to: clampPosition(chunk.endB, currentDoc),
      insert: baseDoc.sliceString(clampPosition(chunk.fromA, baseDoc), clampPosition(chunk.endA, baseDoc)),
    },
  });
  return true;
}

function deleteLineChange(doc: Text, line: { from: number; to: number }) {
  if (line.from === 0) {
    return {
      from: line.from,
      to: line.to < doc.length ? line.to + 1 : line.to,
      insert: '',
    };
  }
  return {
    from: line.to < doc.length ? line.from : line.from - 1,
    to: line.to,
    insert: '',
  };
}

function clampPosition(position: number, doc: Text): number {
  return Math.max(0, Math.min(position, doc.length));
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
