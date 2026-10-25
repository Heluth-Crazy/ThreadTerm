import { useMemo } from 'react';
import { sanitizeMarkdownHtml } from '../markdownPolicy';
import { parseChatMarkdown } from '../chatMath';
import { parseMarkdownFileReference } from '../fileReferences';
import { ChatMarkdown } from './ChatMarkdownExtras';

export function GroupMarkdown({ text, zh, onOpenFile, onOpenUrl }: { text: string; zh: boolean; onOpenFile: (path: string) => void; onOpenUrl: (url: string) => void }) {
 const html = useMemo(() => {
  const parsed = parseChatMarkdown(text), template = document.createElement('template');
  template.innerHTML = typeof parsed === 'string' ? parsed : '';
  for (const element of template.content.querySelectorAll('[data-threadterm-file-reference]')) element.removeAttribute('data-threadterm-file-reference');
  for (const anchor of template.content.querySelectorAll('a[href]')) {
   const reference = parseMarkdownFileReference(anchor.getAttribute('href') ?? '');
   if (reference) { anchor.removeAttribute('href'); anchor.setAttribute('data-threadterm-file-reference', JSON.stringify(reference)); }
  }
  return sanitizeMarkdownHtml(template.innerHTML, { forbidImages: true });
 }, [text]);
 return <div className="gc-markdown" onClickCapture={event => { const anchor = (event.target as Element).closest?.('a[href]'); const href = anchor?.getAttribute('href'); if (href && /^https?:\/\//i.test(href)) { event.preventDefault(); event.stopPropagation(); onOpenUrl(href); } }}><ChatMarkdown sanitizedHtml={html} copy={(en, cn) => zh ? cn : en} zh={zh} openFile={reference => onOpenFile(reference.path)} /></div>;
}
