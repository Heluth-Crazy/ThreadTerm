/*
 * The sandboxed Word viewer (`design.md` §4.3). It fetches `document` from its own grant
 * origin, renders it with `docx-preview`, paints pages lazily and posts only the state hint.
 * Theme and language come from the query string the app appends to the granted URL.
 */
import { renderAsync } from 'docx-preview';

const DOCX_OPTIONS = {
  inWrapper: true,
  hideWrapperOnPrint: false,
  ignoreWidth: false,
  ignoreHeight: false,
  ignoreFonts: false,                 // embedded fonts load under the CSP
  breakPages: true,
  ignoreLastRenderedPageBreak: false, // REQUIRED: the library default yields one endless page
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  renderComments: false,
  renderChanges: false,
  renderAltChunks: false,             // never pull in an altChunk part
  trimXmlDeclaration: true,
  useBase64URL: false,                // blob: URLs: faster and smaller than data: on images
  experimental: false,
  debug: false,
} as const;

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const language = params.get('lang') === 'zh' ? 'zh' : 'en';
document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
document.documentElement.dataset.theme = theme;

const host = document.getElementById('host')!;
let reported = false;

function report(state: 'ready' | 'error') {
  if (reported) return;
  reported = true;
  try { window.parent.postMessage({ type: 'tt-doc-viewer', state }, '*'); } catch { /* the app is gone */ }
}

/** A linked image arrives as `<img src="null">` (spike B §4): a same-origin 404, never a
 * network request. It is cosmetic, so remove it rather than show a broken image. */
function filterLinkedImages() {
  for (const image of host.querySelectorAll('img')) {
    const source = image.getAttribute('src');
    if (source === 'null' || source === '' || /\/viewer\/null(?:[?#]|$)/.test(source ?? '')) image.remove();
  }
}

/** Pages are drawn at their real width (about 816 px for A4/Letter). In a pane narrower than
 * that, scale the pages down to fit instead of cutting off the end of every line; below half
 * size, keep half and let the pane scroll sideways. */
const MIN_FIT = 0.5;
function fitWidth() {
  const wrapper = host.querySelector<HTMLElement>('.docx-wrapper');
  if (!wrapper) return;
  wrapper.style.zoom = '';
  const style = getComputedStyle(host);
  const available = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const needed = wrapper.scrollWidth;
  const scale = needed > 0 && available > 0 ? Math.max(MIN_FIT, Math.min(1, available / needed)) : 1;
  if (scale < 1) wrapper.style.zoom = String(scale);
}

async function main() {
  try {
    const response = await fetch('/document', { cache: 'no-store' });
    if (!response.ok) throw new Error(`document fetch failed: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    await renderAsync(buffer, host, undefined, DOCX_OPTIONS);
    filterLinkedImages();
    fitWidth();
    new ResizeObserver(() => fitWidth()).observe(document.documentElement);
    host.classList.add('rendered');
    report('ready');
  } catch {
    host.replaceChildren();
    host.classList.add('failed');
    report('error');
  }
}

void main();
