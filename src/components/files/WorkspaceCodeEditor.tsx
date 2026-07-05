import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Marked, type Tokens } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';
import highlightThemeCss from 'highlight.js/styles/github-dark.min.css?inline';
import { convertFileSrc } from '@tauri-apps/api/core';
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
import { isTauriEnv } from '../../lib/tauri-bridge';
import {
  codeEditorSyntaxHighlighting,
  loadLanguageExtensions,
  shouldSyntaxHighlight,
} from './codeEditorLanguages';

export interface WorkspaceCodeEditorProps {
  value: string;
  path: string;
  rootPath?: string;
  active: boolean;
  readOnly?: boolean;
  className?: string;
  /** 磁盘内容版本（如 modifiedUnixMs）。src 模式预览的 URL 不随内容变化，
   *  保存/重载后靠它变化触发 iframe 重挂载以刷新。 */
  contentVersion?: number;
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

export type PreviewType = 'markdown' | 'html';

function getPreviewType(path: string): PreviewType | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return null;
}

/** 预览环境上下文；测试注入 stub，运行时用 {@link defaultPreviewContext}。 */
export interface PreviewContext {
  tauri: boolean;
  fileSrc: (absPath: string) => string;
}

function defaultPreviewContext(): PreviewContext {
  return {
    tauri: isTauriEnv(),
    fileSrc: (absPath) => convertFileSrc(absPath),
  };
}

// markdown 预览走 iframe srcdoc，样式只作用于 iframe 文档，与宿主页面天然隔离
const PREVIEW_DOCUMENT_CSS = `
  html{color:#d4d4d4;font-family:system-ui,sans-serif;font-size:14px;line-height:1.7}
  body{padding:20px 28px;max-width:860px;margin:0 auto}
  h1,h2,h3,h4,h5,h6{color:#f0f0f0;margin:1.5em 0 .5em;line-height:1.3}
  h1{font-size:1.8em}h2{font-size:1.45em}h3{font-size:1.2em}
  a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
  code{background:#1e2128;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:.88em}
  pre{background:#1e2128;padding:14px;border-radius:6px;overflow-x:auto}
  pre code{background:none;padding:0;font-size:.85em}
  blockquote{border-left:3px solid #444;margin:0 0 1em;padding:.4em 1em;color:#a0a0a0}
  table{border-collapse:collapse;width:100%;margin:1em 0}
  th,td{border:1px solid #2e3138;padding:6px 12px;text-align:left}
  th{background:#1e2128;font-weight:600}
  img{max-width:100%}hr{border:none;border-top:1px solid #2e3138;margin:1.5em 0}
  ul,ol{padding-left:1.5em}li{margin:.25em 0}p{margin:.75em 0}
`;

function buildMarkdownDoc(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PREVIEW_DOCUMENT_CSS}</style><style>${highlightThemeCss}</style></head><body>${html}</body></html>`;
}

function PreviewPane({
  value,
  previewType,
  path,
  rootPath,
  contentVersion,
}: {
  value: string;
  previewType: PreviewType;
  path: string;
  rootPath?: string;
  contentVersion?: number;
}) {
  const preview = useMemo(
    () => buildPreviewFrame(value, previewType, path, rootPath),
    [path, previewType, rootPath, value],
  );

  return (
    <iframe
      key={preview.src ? `${preview.src}#${contentVersion ?? 0}` : 'inline'}
      src={preview.src}
      srcDoc={preview.srcDoc}
      className="min-h-0 flex-1 w-full border-none"
      title="Preview"
      sandbox={preview.sandbox}
    />
  );
}

/** 单次渲染的资源解析上下文；parse 为同步（async: false），渲染前设置、结束后清空。 */
interface MarkdownAssetContext {
  fileSrc: (absPath: string) => string;
  baseDir: string;
  /** 相对路径解析结果必须落在该 root 内，否则不改写——防止 `../` 链穿越到
   *  其他已注册进 asset scope 的 workspace。 */
  rootDir: string;
}

let markdownAssetContext: MarkdownAssetContext | null = null;

function isRelativeAssetPath(href: string): boolean {
  if (!href) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false; // 带 scheme（https:、data: 等）
  if (href.startsWith('//') || href.startsWith('/')) return false; // 绝对路径语义不明，原样放过
  return true;
}

// 模块级单例，不污染全局 marked
const markdownRenderer = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
  {
    renderer: {
      // Tauri 内把相对图片改写为 asset 协议 URL；其余保持默认渲染
      image({ href, title, text }: Tokens.Image): string | false {
        const context = markdownAssetContext;
        if (!context || !isRelativeAssetPath(href)) return false;
        const resolved = joinWorkspacePath(context.baseDir, href);
        if (workspaceRelativePath(context.rootDir, resolved) === null) return false;
        const src = context.fileSrc(resolved);
        const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
        return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(text)}"${titleAttr}>`;
      },
      // http/https 外链在新窗口打开；锚点与相对链接保持默认渲染
      link({ href, title, tokens }: Tokens.Link): string | false {
        if (!/^https?:\/\//i.test(href)) return false;
        const text = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
        return `<a href="${escapeHtmlAttribute(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    },
  },
);

function renderMarkdown(
  value: string,
  path: string,
  rootPath: string | undefined,
  ctx: PreviewContext,
): string {
  markdownAssetContext =
    ctx.tauri && rootPath
      ? { fileSrc: ctx.fileSrc, baseDir: dirnameOf(path), rootDir: rootPath }
      : null;
  try {
    return markdownRenderer.parse(value, { async: false });
  } finally {
    markdownAssetContext = null;
  }
}

export interface PreviewFrame {
  src?: string;
  srcDoc?: string;
  sandbox: string;
}

export function buildPreviewFrame(
  value: string,
  previewType: PreviewType,
  path: string,
  rootPath?: string,
  ctx: PreviewContext = defaultPreviewContext(),
): PreviewFrame {
  if (previewType === 'html') {
    if (ctx.tauri) {
      // asset 协议直读磁盘上已保存的文件（Live-Server 语义）；
      // src 文档不继承宿主 CSP，内联脚本与相对资源全部可用
      return { src: ctx.fileSrc(path), sandbox: 'allow-scripts allow-popups' };
    }
    // 纯浏览器 dev：srcdoc + <base> 注入，保持相对资源可解析
    return {
      srcDoc: injectPreviewBase(value, previewBaseHref(rootPath, path)),
      sandbox: 'allow-scripts allow-popups',
    };
  }

  // markdown 为静态渲染且 marked 不做 sanitize：
  // 靠不含 allow-scripts 的 sandbox 阻断内嵌脚本执行
  return {
    srcDoc: buildMarkdownDoc(renderMarkdown(value, path, rootPath, ctx)),
    sandbox: 'allow-popups',
  };
}

function workspaceRelativePath(rootPath: string, filePath: string): string | null {
  const root = normalizeFsPath(rootPath);
  const file = normalizeFsPath(filePath);
  if (!root || !file) return null;

  const rootForCompare = isWindowsPath(root) ? root.toLowerCase() : root;
  const fileForCompare = isWindowsPath(file) ? file.toLowerCase() : file;
  const rootPrefix = `${rootForCompare}/`;
  if (!fileForCompare.startsWith(rootPrefix)) return null;

  return file.slice(root.length + 1);
}

function normalizeFsPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function isWindowsPath(path: string): boolean {
  return /^[a-z]:\//i.test(path);
}

function previewBaseHref(rootPath: string | undefined, filePath: string): string {
  const relativePath = rootPath ? workspaceRelativePath(rootPath, filePath) : null;
  if (!relativePath) return document.baseURI;

  const directory = relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/') + 1)
    : '';
  const encodedDirectory = directory.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return new URL(encodedDirectory ? `${encodedDirectory}/` : './', document.baseURI).href;
}

function injectPreviewBase(html: string, baseHref: string): string {
  if (/<base\b/i.test(html)) return html;

  const baseTag = `<base href="${escapeHtmlAttribute(baseHref)}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${baseTag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (htmlTag) => `${htmlTag}<head>${baseTag}</head>`);
  }
  return `<!DOCTYPE html><html><head>${baseTag}</head><body>${html}</body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 提取路径的目录部分；反斜杠归一为 /，无目录时返回空字符串。 */
export function dirnameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) return '';
  return normalized.slice(0, lastSlash) || '/';
}

/** 以 dir 为基准解析相对路径；处理 ./ 与 ../（不越过根），保留 Windows 盘符根（C:/）。 */
export function joinWorkspacePath(dir: string, relative: string): string {
  const normalizedDir = dir.replace(/\\/g, '/');
  const driveMatch = /^[a-z]:(?=\/|$)/i.exec(normalizedDir);
  let root = '';
  let rest = normalizedDir;
  if (driveMatch) {
    root = `${driveMatch[0]}/`;
    rest = normalizedDir.slice(driveMatch[0].length);
  } else if (normalizedDir.startsWith('/')) {
    root = '/';
    rest = normalizedDir.slice(1);
  }

  const segments: string[] = [];
  const pushSegment = (segment: string) => {
    if (!segment || segment === '.') return;
    if (segment === '..') {
      segments.pop(); // 已在根时无可弹出，直接丢弃，不越过根
      return;
    }
    segments.push(segment);
  };
  rest.split('/').forEach(pushSegment);
  relative.replace(/\\/g, '/').split('/').forEach(pushSegment);
  return root + segments.join('/');
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
  rootPath,
  active,
  readOnly = false,
  className,
  contentVersion,
  onChange,
  onSave,
}: WorkspaceCodeEditorProps) {
  const { t } = useTranslation('terminal');
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const languageExtensions = useLanguageExtensions(path, value);
  const saveRef = useRef(onSave);
  const previewType = getPreviewType(path);
  const [previewMode, setPreviewMode] = useState(false);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  // 切换文件时重置预览状态
  useEffect(() => {
    setPreviewMode(false);
  }, [path]);

  useEffect(() => {
    if (active && !previewMode) {
      editorRef.current?.view?.focus();
    }
  }, [active, previewMode]);

  const extensions = useMemo(
    () => [
      codeEditorTheme,
      codeEditorSyntaxHighlighting,
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
    <div
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', className)}
      onKeyDown={
        previewMode && previewType
          ? (event) => {
              // 预览时 CodeMirror 的 Mod-s keymap 收不到按键，在根容器兜底保存；
              // 焦点在 iframe 内时按键不会冒泡出来，接受该限制
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveRef.current?.();
              }
            }
          : undefined
      }
    >
      {previewType && (
        <div className="flex min-h-[30px] shrink-0 items-center border-b border-white/10 px-2">
          <button
            type="button"
            onClick={() => setPreviewMode(false)}
            className={cn(
              'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
              !previewMode
                ? 'bg-primary/15 text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {t('workspace.previewEdit')}
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode(true)}
            className={cn(
              'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
              previewMode
                ? 'bg-primary/15 text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {t('workspace.previewPreview')}
          </button>
        </div>
      )}
      {previewMode && previewType && (
        <PreviewPane
          value={value}
          previewType={previewType}
          path={path}
          rootPath={rootPath}
          contentVersion={contentVersion}
        />
      )}
      {/* CodeMirror 常驻不卸载，预览时仅隐藏，保住 undo 历史/光标/滚动位置 */}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden',
          previewMode && previewType && 'hidden',
        )}
      >
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
            syntaxHighlighting: false,
          }}
          extensions={extensions}
          readOnly={readOnly}
          editable={!readOnly}
          indentWithTab
          onChange={(nextValue) => onChange?.(nextValue)}
          className="min-h-0 flex-1 overflow-hidden"
        />
      </div>
    </div>
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
      codeEditorSyntaxHighlighting,
      EditorView.lineWrapping,
      editable ? createDiffLineActionPlaceholderGutter() : [],
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      ...languageExtensions,
    ];
    const currentExtensions: Extension[] = [
      codeEditorTheme,
      codeEditorSyntaxHighlighting,
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
  const shouldHighlight = shouldSyntaxHighlight(value);

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
