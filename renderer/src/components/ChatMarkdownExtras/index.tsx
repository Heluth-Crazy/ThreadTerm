import { createElement, lazy, Suspense, useCallback, type ReactNode } from 'react';
import type { FileReference } from '@threadterm/protocol';
import { inertRemoteImage } from '../../markdownPolicy';
import { FileLinkedMarkdown } from '../FileReferenceText';
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

export function ChatMarkdown({ sanitizedHtml, references, openFile, copy, onInsert }: { sanitizedHtml: string; references?: FileReference[]; openFile?: (reference: FileReference) => void; copy: BlockProps['copy']; onInsert?: BlockProps['onInsert'] }) {
  const rendered = useCallback((html: string): ReactNode => {
    const root = document.createElement('div'); root.innerHTML = html;
    const node = (value: Node, key: number): ReactNode => {
      if (value.nodeType === Node.TEXT_NODE) return value.textContent;
      if (!(value instanceof HTMLElement)) return null;
      // An inert remote image (F17) is a real component: loading it must not rewrite DOM React owns.
      const inertImage = value.matches('.md-remote-image') ? inertRemoteImage(value.getAttribute('data-remote-image'), value.querySelector('.md-remote-image-alt')?.textContent) : undefined;
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
  }, [copy, onInsert]);
  const extras = /language-(?:mermaid|json|threadterm-ui)|data-threadterm-math/.test(sanitizedHtml);
  return <FileLinkedMarkdown sanitizedHtml={sanitizedHtml} references={references} openFile={openFile} renderHtml={extras ? rendered : undefined} />;
}
