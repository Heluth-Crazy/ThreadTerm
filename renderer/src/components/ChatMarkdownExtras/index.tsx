import { createElement, lazy, Suspense, useCallback, useRef, type ReactNode } from 'react';
import type { FileReference } from '@threadterm/protocol';
import { inertRemoteImage } from '../../markdownPolicy';
import { FileLinkedMarkdown, FileLinkedMarkdownBlocks, type MarkdownBlock as MarkdownHtmlBlock } from '../FileReferenceText';
import { RemoteImage } from '../RemoteImage';
import './markdown-extras.css';

export type BlockProps = { kind: 'mermaid' | 'json' | 'math' | 'threadterm-ui'; source: string; copy: (en: string, zh: string) => string; display?: boolean; onInsert?: (text: string) => void };
const Mermaid = lazy(() => import('./MermaidBlock'));
const Math = lazy(() => import('./MathBlock'));
const Json = lazy(() => import('./JsonBlock'));
const Generated = lazy(() => import('./GeneratedUi'));

export function MarkdownBlock(props: BlockProps) {
  const Component = props.kind === 'mermaid' ? Mermaid : props.kind === 'math' ? Math : props.kind === 'json' ? Json : Generated;
  return <Suspense fallback={<div className="markdown-extra-loading" role="status">{props.copy('Loading renderer…', '正在加载渲染器…')}<pre>{props.source}</pre></div>}><Component {...props} /></Suspense>;
}

/** Sanitized Markdown HTML with a Mermaid, JSON, generated-UI or math block, which render as components. */
export const hasMarkdownExtras = (html: string) => /language-(?:mermaid|json|threadterm-ui)|data-threadterm-math/.test(html);

type ExtrasContext = { copy: BlockProps['copy']; onInsert?: BlockProps['onInsert']; zh?: boolean };
/** Sanitized, decorated Markdown HTML as React elements, with extras as their components. */
export function markdownHtmlToReact(html: string, { copy, onInsert, zh }: ExtrasContext): ReactNode {
  const root = document.createElement('div'); root.innerHTML = html;
  const node = (value: Node, key: number): ReactNode => {
    if (value.nodeType === Node.TEXT_NODE) return value.textContent;
    if (!(value instanceof HTMLElement)) return null;
    // An inert remote image (F17) is a real component: loading it must not rewrite DOM React owns.
    const inertImage = value.matches('.md-remote-image') ? inertRemoteImage(value.getAttribute('data-remote-image'), value.querySelector('.md-remote-image-alt')?.textContent, zh) : undefined;
    if (inertImage) return <RemoteImage key={`${key}:${inertImage.source}`} image={inertImage} />;
    const code = value.matches('.md-code-block, pre') ? value.querySelector('pre > code, :scope > code') : null;
    const kind = code && (['mermaid', 'json', 'threadterm-ui'] as const).find(kind => code.classList.contains(`language-${kind}`));
    if (kind) return <MarkdownBlock key={key} kind={kind} source={code!.textContent ?? ''} copy={copy} onInsert={onInsert} />;
    if (value.hasAttribute('data-threadterm-math')) return <MarkdownBlock key={key} kind="math" source={value.textContent ?? ''} display={value.dataset.threadtermMath === 'display'} copy={copy} />;
    const props: Record<string, unknown> = { key };
    for (const attribute of Array.from(value.attributes)) {
      if (attribute.name === 'class') props.className = attribute.value;
      else if (attribute.name === 'colspan') props.colSpan = attribute.value;
      else if (attribute.name === 'rowspan') props.rowSpan = attribute.value;
      else if (['title', 'href', 'src', 'alt', 'target', 'rel', 'type', 'start'].includes(attribute.name) || /^(?:data|aria)-/.test(attribute.name)) props[attribute.name] = attribute.value;
    }
    const tag = value.tagName.toLowerCase();
    return createElement(tag, props, ...(['img', 'br', 'hr', 'wbr'].includes(tag) ? [] : Array.from(value.childNodes).map(node)));
  };
  return Array.from(root.childNodes).map(node);
}

export function ChatMarkdown({ sanitizedHtml, references, openFile, copy, onInsert, zh }: { sanitizedHtml: string; references?: FileReference[]; openFile?: (reference: FileReference) => void; copy: BlockProps['copy']; onInsert?: BlockProps['onInsert']; zh?: boolean }) {
  const rendered = useCallback((html: string): ReactNode => markdownHtmlToReact(html, { copy, onInsert, zh }), [copy, onInsert, zh]);
  return <FileLinkedMarkdown sanitizedHtml={sanitizedHtml} references={references} openFile={openFile} renderHtml={hasMarkdownExtras(sanitizedHtml) ? rendered : undefined} />;
}

/** One block of a streaming reply (ChatView `CodexMarkdownPart`): its sanitized HTML, file references, and whether it
 * holds an extra. */
export type ChatMarkdownBlock = MarkdownHtmlBlock & { extras: boolean };

/** `ChatMarkdown` for a reply rendered block by block. As in `ChatMarkdown`, the whole reply takes the component path
 * once any block holds an extra. Blocks keep their DOM while unchanged, so the extras callbacks are read through a ref:
 * a block rendered earlier always calls the current `copy` and `onInsert`. */
export function ChatMarkdownBlocks({ blocks, references, openFile, copy, onInsert, zh }: { blocks: readonly ChatMarkdownBlock[]; references?: FileReference[]; openFile?: (reference: FileReference) => void; copy: BlockProps['copy']; onInsert?: BlockProps['onInsert']; zh?: boolean }) {
  const current = useRef({ copy, onInsert });
  current.current = { copy, onInsert };
  const insertable = Boolean(onInsert);
  const rendered = useCallback((html: string): ReactNode => markdownHtmlToReact(html, {
    copy: (en, zhText) => current.current.copy(en, zhText),
    onInsert: insertable ? text => current.current.onInsert?.(text) : undefined,
    zh,
  }), [insertable, zh]);
  return <FileLinkedMarkdownBlocks blocks={blocks} references={references} openFile={openFile}
    renderHtml={blocks.some(block => block.extras) ? rendered : undefined} renderKey={`${zh ? 'zh' : 'en'}:${insertable ? 1 : 0}`} />;
}
