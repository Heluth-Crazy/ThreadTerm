import { Fragment, useMemo, type MouseEvent, type ReactNode } from 'react';
import type { FileReference } from '@threadterm/protocol';
import { extractFileReferences, parseFileReference, parseMarkdownFileReference } from '../fileReferences';

type OpenFile = (reference: FileReference) => void;

const sameReference = (a: FileReference, b: FileReference) =>
  a.path === b.path && a.line === b.line && a.column === b.column;
const utf8 = new TextEncoder();

// Structured tool paths are native candidates, not prose to classify by
// extension or separators. The runtime resolver remains authoritative.
function structuredPath(path: string): string | undefined {
  if (typeof path !== 'string') return;
  const value = path.trim();
  if (!value || value.length > 16 * 1024 || utf8.encode(value).length > 16 * 1024 || /\p{Cc}/u.test(value)) return;
  if (/^file:\/\//i.test(value)) {
    if (/[?#%]/.test(value)) return;
    const rest = value.slice(7);
    if (rest.startsWith('/')) {
      const local = rest.replace(/^\/+/, '');
      return /^[a-z]:[\\/]/i.test(local) ? local : undefined;
    }
    const slash = rest.indexOf('/');
    return slash > 0 && slash < rest.length - 1 ? `\\\\${rest.slice(0, slash)}\\${rest.slice(slash + 1)}` : undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
  if (value.includes('://')) return;
  return value;
}

export function FileLinkedText({ text, openFile }: { text: string; openFile?: OpenFile }) {
  if (!openFile) return text;
  const candidates = extractFileReferences(text);
  if (!candidates.length) return text;
  const pieces: ReactNode[] = [];
  let offset = 0;
  for (const candidate of candidates) {
    if (candidate.start < offset) continue;
    pieces.push(text.slice(offset, candidate.start));
    const reference = { path: candidate.path, ...(candidate.line ? { line: candidate.line } : {}), ...(candidate.column ? { column: candidate.column } : {}) };
    pieces.push(<button type="button" className="file-reference-link" key={candidate.start} onClick={() => openFile(reference)} title={candidate.path}>{text.slice(candidate.start, candidate.end)}</button>);
    offset = candidate.end;
  }
  pieces.push(text.slice(offset));
  return <Fragment>{pieces}</Fragment>;
}

export function FileReferenceChips({ references, visibleText, openFile }: { references?: FileReference[]; visibleText?: string; openFile?: OpenFile }) {
  if (!openFile || !references?.length) return null;
  const unique: FileReference[] = [];
  const visible = visibleText ? extractFileReferences(visibleText) : [];
  for (const reference of references.slice(0, 256)) {
    const path = structuredPath(reference.path);
    if (!path) continue;
    const normalized = { path, ...(reference.line ? { line: reference.line } : {}), ...(reference.column ? { column: reference.column } : {}) };
    if (unique.some(value => sameReference(value, normalized))) continue;
    if (visible.some(value => sameReference(value, normalized))) continue;
    unique.push(normalized);
    if (unique.length === 32) break;
  }
  if (!unique.length) return null;
  return <div className="file-reference-chips" aria-label="File references">{unique.map((reference, index) =>
    <button type="button" className="file-reference-link" key={`${reference.path}:${index}`} onClick={() => openFile(reference)} title={reference.path}>{reference.path}{reference.line ? `:${reference.line}${reference.column ? `:${reference.column}` : ''}` : ''}</button>
  )}</div>;
}

// The HTML has already passed DOMPurify. Only create textContent and inert
// buttons here; never carry raw model HTML into an attribute or URL.
function decorateMarkdown(sanitized: string, interactive: boolean): string {
  const root = document.createElement('div');
  root.innerHTML = sanitized;
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    let reference = parseMarkdownFileReference(anchor.getAttribute('href') ?? '');
    const encoded = anchor.getAttribute('data-threadterm-file-reference');
    if (encoded) try {
      const value = JSON.parse(encoded) as FileReference;
      if (value && typeof value.path === 'string' && parseFileReference(value.path)
        && (value.line === undefined || Number.isSafeInteger(value.line) && value.line >= 1 && value.line <= 1_000_000)
        && (value.column === undefined || Number.isSafeInteger(value.column) && value.column >= 1 && value.column <= 1_000_000)) reference = value;
    } catch { /* Ignore malformed inert metadata. */ }
    if (!reference) continue;
    if (!interactive) {
      anchor.replaceWith(document.createTextNode(anchor.textContent || reference.path));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'file-reference-link';
    button.dataset.fileReference = JSON.stringify(reference);
    button.textContent = anchor.textContent || reference.path;
    anchor.replaceWith(button);
  }
  if (!interactive) return root.innerHTML;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    if (node.parentElement?.closest('button, a')) continue;
    const text = node.textContent ?? '';
    const candidates = extractFileReferences(text);
    if (!candidates.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const candidate of candidates) {
      if (candidate.start < offset) continue;
      fragment.append(document.createTextNode(text.slice(offset, candidate.start)));
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'file-reference-link';
      button.dataset.fileReference = JSON.stringify({ path: candidate.path, ...(candidate.line ? { line: candidate.line } : {}), ...(candidate.column ? { column: candidate.column } : {}) });
      button.textContent = text.slice(candidate.start, candidate.end);
      fragment.append(button);
      offset = candidate.end;
    }
    fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
  return root.innerHTML;
}

export function FileLinkedMarkdown({ sanitizedHtml, references, openFile }: { sanitizedHtml: string; references?: FileReference[]; openFile?: OpenFile }) {
  const interactive = Boolean(openFile);
  const rendered = useMemo(() => {
    const html = decorateMarkdown(sanitizedHtml, interactive);
    const container = document.createElement('div');
    container.innerHTML = html;
    return { innerHtml: { __html: html }, visibleText: container.textContent ?? '' };
  }, [interactive, sanitizedHtml]);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest('button[data-file-reference]') : null;
    if (!target || !event.currentTarget.contains(target) || !openFile) return;
    try {
      const reference = JSON.parse((target as HTMLElement).dataset.fileReference ?? '') as FileReference;
      if (parseFileReference(reference.path)) openFile(reference);
    } catch { /* Ignore malformed display metadata. */ }
  };
  return <>
    <div className="v3-message-text codex-markdown" dangerouslySetInnerHTML={rendered.innerHtml} onClick={onClick} />
    <FileReferenceChips references={references} visibleText={rendered.visibleText} openFile={openFile} />
  </>;
}
