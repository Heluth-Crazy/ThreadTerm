/**
 * Syntax colours for fenced code in chat replies (11-23). The engine and its grammars are lazy chunks, so
 * startup pays nothing: the first render of a fenced block shows it plain and starts the load, and the
 * version below changes once a grammar lands, which re-renders the replies that use it.
 *
 * Highlighting runs on markup the sanitizer already cleaned. It only splits a block's own text into spans
 * with our own `hl-*` classes, the same way the copy buttons are added after sanitizing.
 */
type Engine = typeof import('./codeHighlightEngine');

let engine: Engine | undefined;
let loading: Promise<void> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function load(): void {
  loading ??= import('./codeHighlightEngine').then(module => {
    engine = module;
    module.onGrammarLoaded(changed);
    changed();
  }, () => { /* No engine: code stays plain. */ });
}

export function subscribeCodeHighlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Changes whenever more code can be coloured; part of every cache key for rendered replies. */
export function codeHighlightVersion(): number {
  return version;
}

const FENCE = /(?:^|\s)language-([\w#+.-]{1,32})(?:\s|$)/;

/** A Markdown source with a fenced block, the only replies highlighting can change. */
export function hasCodeFence(text: string): boolean {
  return /^\s{0,3}(?:```|~~~)/m.test(text);
}

/** Colours every `pre > code.language-*` under `root` whose grammar is ready; starts loading the rest. */
export function highlightCodeBlocks(root: ParentNode): void {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'))) {
    const fence = FENCE.exec(code.className)?.[1]?.toLowerCase();
    if (!fence || ['mermaid', 'json-render', 'threadterm-ui', 'math'].includes(fence)) continue;
    if (!engine) { load(); return; }
    engine.highlightCode(code, fence);
  }
}
