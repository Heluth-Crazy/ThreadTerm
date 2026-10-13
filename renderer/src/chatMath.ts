import { Marked } from 'marked';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
const markdown = new Marked({ gfm: true, breaks: true });
markdown.use({ extensions: [
  { name: 'inlineDisplayMath', level: 'inline', start: source => source.indexOf('$$'), tokenizer(source) {
    const match = /^\$\$([^$]+?)\$\$/.exec(source);
    if (match) return { type: 'inlineDisplayMath', raw: match[0], text: match[1].trim() };
  }, renderer(token) { return `<span data-threadterm-math="display">${escapeHtml(String(token.text))}</span>`; } },
  { name: 'inlineMath', level: 'inline', start: source => source.indexOf('$'), tokenizer(source) {
    const match = /^\$(?!\$|\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\$)/.exec(source);
    if (match) return { type: 'inlineMath', raw: match[0], text: match[1] };
  }, renderer(token) { return `<span data-threadterm-math="inline">${escapeHtml(String(token.text))}</span>`; } },
  { name: 'displayMath', level: 'block', start: source => source.indexOf('$$'), tokenizer(source) {
    const match = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n|$)/.exec(source);
    if (match) return { type: 'displayMath', raw: match[0], text: match[1] };
  }, renderer(token) { return `<div data-threadterm-math="display">${escapeHtml(String(token.text))}</div>`; } },
] });
/** Marked tokenization keeps code spans/blocks opaque; KaTeX is absent here. */
export const parseChatMarkdown = (source: string) => markdown.parse(source);
