import type { Parser } from '@lezer/common';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';

/**
 * Syntax colours for fenced code in chat replies (11-23). This module and every grammar are their own
 * chunks: `codeHighlight.ts` loads them on the first fenced block. Token groups and colours follow the
 * editor (`workbench/languages.ts`, the `--syn-*` variables), so a reply's code looks like the file.
 */
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], class: 'hl-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], class: 'hl-string' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], class: 'hl-number' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'hl-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], class: 'hl-function' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.typeName), t.definition(t.typeName)], class: 'hl-type' },
  { tag: [t.propertyName, t.attributeName, t.labelName], class: 'hl-property' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.escape], class: 'hl-meta' },
  { tag: t.heading, class: 'hl-heading' },
  { tag: [t.inserted], class: 'hl-inserted' },
  { tag: [t.deleted, t.invalid], class: 'hl-deleted' },
]);

const legacy = async (mode: Promise<StreamParser<unknown>>): Promise<Parser> => StreamLanguage.define(await mode).parser;

const grammars: Record<string, () => Promise<Parser>> = {
  ts: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }).language.parser,
  tsx: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }).language.parser,
  js: async () => (await import('@codemirror/lang-javascript')).javascript().language.parser,
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }).language.parser,
  json: async () => (await import('@codemirror/lang-json')).json().language.parser,
  py: async () => (await import('@codemirror/lang-python')).python().language.parser,
  rs: async () => (await import('@codemirror/lang-rust')).rust().language.parser,
  go: async () => (await import('@codemirror/lang-go')).go().language.parser,
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp().language.parser,
  java: async () => (await import('@codemirror/lang-java')).java().language.parser,
  css: async () => (await import('@codemirror/lang-css')).css().language.parser,
  html: async () => (await import('@codemirror/lang-html')).html().language.parser,
  xml: async () => (await import('@codemirror/lang-xml')).xml().language.parser,
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml().language.parser,
  sql: async () => (await import('@codemirror/lang-sql')).sql().language.parser,
  php: async () => (await import('@codemirror/lang-php')).php().language.parser,
  md: async () => (await import('@codemirror/lang-markdown')).markdown().language.parser,
  sh: () => legacy(import('@codemirror/legacy-modes/mode/shell').then(mode => mode.shell)),
  ps1: () => legacy(import('@codemirror/legacy-modes/mode/powershell').then(mode => mode.powerShell)),
  toml: () => legacy(import('@codemirror/legacy-modes/mode/toml').then(mode => mode.toml)),
  diff: () => legacy(import('@codemirror/legacy-modes/mode/diff').then(mode => mode.diff)),
  rb: () => legacy(import('@codemirror/legacy-modes/mode/ruby').then(mode => mode.ruby)),
  lua: () => legacy(import('@codemirror/legacy-modes/mode/lua').then(mode => mode.lua)),
  swift: () => legacy(import('@codemirror/legacy-modes/mode/swift').then(mode => mode.swift)),
  kt: () => legacy(import('@codemirror/legacy-modes/mode/clike').then(mode => mode.kotlin)),
  cs: () => legacy(import('@codemirror/legacy-modes/mode/clike').then(mode => mode.csharp)),
  dockerfile: () => legacy(import('@codemirror/legacy-modes/mode/dockerfile').then(mode => mode.dockerFile)),
  ini: () => legacy(import('@codemirror/legacy-modes/mode/properties').then(mode => mode.properties)),
};

/** Fence names models write, mapped onto the grammars above. */
const aliases: Record<string, string> = {
  typescript: 'ts', mts: 'ts', cts: 'ts', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js',
  jsonc: 'json', json5: 'json', python: 'py', py3: 'py', python3: 'py', rust: 'rs', golang: 'go',
  c: 'cpp', h: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', 'c++': 'cpp', objc: 'cpp', scss: 'css', less: 'css',
  htm: 'html', vue: 'html', svelte: 'html', svg: 'xml', xaml: 'xml', csproj: 'xml', yml: 'yaml',
  markdown: 'md', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh', 'sh-session': 'sh',
  powershell: 'ps1', pwsh: 'ps1', ps: 'ps1', patch: 'diff', ruby: 'rb', kotlin: 'kt', kts: 'kt', csharp: 'cs',
  'c#': 'cs', docker: 'dockerfile', properties: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
};

/** Longer blocks stay plain: parsing them would stall the reply they are in. */
const MAX_CHARS = 120_000;

const parsers = new Map<string, Parser | null>();
const pending = new Set<string>();
let loaded: () => void = () => {};

export function onGrammarLoaded(listener: () => void): void { loaded = listener; }

export function grammarFor(fence: string): string | undefined {
  const name = aliases[fence] ?? fence;
  return grammars[name] ? name : undefined;
}

/**
 * Colours one `<code>` element in place, from its own text. Returns false when its grammar is not loaded
 * yet; the load starts and `onGrammarLoaded`'s listener runs once it lands. Never throws.
 */
export function highlightCode(code: HTMLElement, fence: string): boolean {
  const name = grammarFor(fence);
  if (!name) return true;
  const parser = parsers.get(name);
  if (parser === undefined) {
    if (!pending.has(name)) {
      pending.add(name);
      grammars[name]!().then(value => parsers.set(name, value), () => parsers.set(name, null))
        .finally(() => { pending.delete(name); loaded(); });
    }
    return false;
  }
  const text = code.textContent ?? '';
  if (!parser || !text || text.length > MAX_CHARS) return true;
  try {
    const tree = parser.parse(text);
    const fragment = document.createDocumentFragment();
    let position = 0;
    highlightTree(tree, highlighter, (from, to, classes) => {
      if (from > position) fragment.append(text.slice(position, from));
      const span = document.createElement('span');
      span.className = classes;
      span.textContent = text.slice(from, to);
      fragment.append(span);
      position = to;
    });
    if (position < text.length) fragment.append(text.slice(position));
    code.replaceChildren(fragment);
  } catch { /* A grammar that cannot parse this block leaves it plain. */ }
  return true;
}
