import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

export const SYNTAX_HIGHLIGHT_MAX_BYTES = 512 * 1024;

export const codeEditorSyntaxHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: 'hsl(213 94% 68%)' },
    { tag: [t.name, t.variableName], color: 'hsl(var(--foreground))' },
    { tag: [t.definition(t.variableName), t.function(t.variableName)], color: 'hsl(199 89% 64%)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'hsl(43 96% 64%)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'hsl(142 69% 58%)' },
    { tag: [t.number, t.bool, t.null], color: 'hsl(25 95% 67%)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'hsl(var(--muted-foreground) / 0.78)', fontStyle: 'italic' },
    { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator], color: 'hsl(280 90% 74%)' },
    { tag: [t.tagName, t.angleBracket], color: 'hsl(348 83% 72%)' },
    { tag: [t.attributeName, t.propertyName], color: 'hsl(48 96% 67%)' },
    { tag: [t.heading, t.strong], color: 'hsl(var(--foreground))', fontWeight: '600' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.link, t.url], color: 'hsl(199 89% 64%)', textDecoration: 'underline' },
    { tag: [t.invalid], color: 'hsl(var(--destructive))' },
  ]),
);

export function shouldSyntaxHighlight(value: string): boolean {
  return textByteLength(value) <= SYNTAX_HIGHLIGHT_MAX_BYTES;
}

export async function loadLanguageExtensions(path: string): Promise<Extension[]> {
  const lower = path.toLowerCase();
  const basename = lower.split(/[\\/]/).pop() ?? lower;

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
  if (/\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(lower)) {
    const { cpp } = await import('@codemirror/lang-cpp');
    return [cpp()];
  }
  if (lower.endsWith('.java')) {
    const { java } = await import('@codemirror/lang-java');
    return [java()];
  }
  if (lower.endsWith('.go')) {
    const { go } = await import('@codemirror/lang-go');
    return [go()];
  }
  if (lower.endsWith('.php')) {
    const { php } = await import('@codemirror/lang-php');
    return [php()];
  }
  if (lower.endsWith('.sql')) {
    const { sql } = await import('@codemirror/lang-sql');
    return [sql()];
  }
  if (/\.(sh|bash|zsh)$/.test(lower)) {
    const { shell } = await import('@codemirror/legacy-modes/mode/shell');
    return [legacy(shell)];
  }
  if (/\.(ps1|psm1|psd1)$/.test(lower)) {
    const { powerShell } = await import('@codemirror/legacy-modes/mode/powershell');
    return [legacy(powerShell)];
  }
  if (lower.endsWith('.toml')) {
    const { toml } = await import('@codemirror/legacy-modes/mode/toml');
    return [legacy(toml)];
  }
  if (basename === 'dockerfile' || basename === 'containerfile' || basename.endsWith('.dockerfile')) {
    const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
    return [legacy(dockerFile)];
  }
  if (/\.(properties|ini|env)$/.test(lower) || basename === '.env') {
    const { properties } = await import('@codemirror/legacy-modes/mode/properties');
    return [legacy(properties)];
  }
  return [];
}

function legacy(parser: Parameters<typeof StreamLanguage.define>[0]): Extension {
  return StreamLanguage.define(parser);
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
