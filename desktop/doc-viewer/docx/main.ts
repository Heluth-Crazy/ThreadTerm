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
  renderComments: true,               // 批注: see setupComments()
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

/** Comments (批注). docx-preview marks each commented range with a CSS highlight (`docx-comments`) and puts a 💬
 * with a hidden popover after it. That popover sits inside the page, where lazy page painting clips it and the
 * fit-to-width zoom shrinks it, and it vanishes as soon as the pointer leaves the 💬. One card floating over the
 * pages shows the comment instead: hover or focus a 💬 to read it, click to keep it open, Esc or a click elsewhere
 * closes it. The commented text of the comment on show is highlighted more strongly. */
const COMMENT_REF = '.docx-comment-ref';
const ACTIVE_COMMENT_HIGHLIGHT = 'tt-comment-active';

/** The commented range of each comment id, rebuilt from the markers docx-preview leaves in the DOM. */
function commentRanges(): Map<string, Range> {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT);
  const starts = new Map<string, Node>();
  const ranges = new Map<string, Range>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const marker = node.nodeValue ?? '';
    const start = /^start of comment #(\S+)$/.exec(marker);
    if (start) { starts.set(start[1], node); continue; }
    const end = /^end of comment #(\S+)$/.exec(marker);
    const from = end && starts.get(end[1]);
    if (!end || !from) continue;
    const range = new Range();
    range.setStartAfter(from);
    range.setEndBefore(node);
    ranges.set(end[1], range);
  }
  return ranges;
}

/** docx-preview leaves `comment #<id> by <author> on <date>` just before each 💬. */
function commentMarker(ref: Element): string {
  const marker = ref.previousSibling;
  return marker?.nodeType === Node.COMMENT_NODE ? marker.nodeValue ?? '' : '';
}

function commentId(ref: Element): string | undefined {
  return /^comment #(\S+) by /.exec(commentMarker(ref))?.[1];
}

/** The comment's date in the app's language, or '' when the comment has none. docx-preview prints
 * `new Date(undefined)` for a comment without one (1970 or "Invalid Date"), so read the raw value instead. Word writes
 * the author's wall-clock time with a `Z`, so it is shown as written rather than shifted into this time zone. */
function commentDate(ref: Element): string {
  const raw = /^comment #\S+ by [\s\S]* on ([\s\S]*)$/.exec(commentMarker(ref))?.[1] ?? '';
  const time = raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(time);
}

function setupComments() {
  const refs = host.querySelectorAll<HTMLElement>(COMMENT_REF);
  if (refs.length === 0) return;
  const label = language === 'zh' ? '批注' : 'Comment';
  for (const ref of refs) {
    ref.tabIndex = 0;
    ref.setAttribute('role', 'button');
    ref.setAttribute('aria-label', label);
  }
  const ranges = commentRanges();
  const highlights = 'highlights' in CSS ? CSS.highlights : undefined;
  const card = document.createElement('div');
  card.id = 'tt-comment-card';
  card.className = 'tt-comment-card';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  document.body.append(card);
  let shown: HTMLElement | undefined;
  let pinned = false;
  let hideTimer: number | undefined;

  const fill = (ref: HTMLElement) => {
    const popover = ref.nextElementSibling;
    const author = popover?.querySelector('.docx-comment-author')?.textContent?.trim() ?? '';
    const date = commentDate(ref);
    const head = document.createElement('div');
    head.className = 'tt-comment-head';
    const who = document.createElement('span');
    who.className = 'tt-comment-author';
    who.textContent = author || label;
    head.append(who);
    if (date) {
      const when = document.createElement('span');
      when.className = 'tt-comment-date';
      when.textContent = date;
      head.append(when);
    }
    card.replaceChildren(head);
    // The comment body is Word paragraphs styled for the page; the card shows their text in its own type.
    for (const paragraph of popover?.querySelectorAll('p') ?? []) {
      const line = document.createElement('p');
      line.className = 'tt-comment-text';
      line.textContent = paragraph.textContent ?? '';
      card.append(line);
    }
  };
  const place = () => {
    if (!shown) return;
    const anchor = shown.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    let top = anchor.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 6);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  };
  const show = (ref: HTMLElement) => {
    window.clearTimeout(hideTimer);
    if (shown === ref) return;
    hide();
    shown = ref;
    fill(ref);
    card.hidden = false;
    place();
    ref.classList.add('is-active');
    ref.setAttribute('aria-describedby', card.id);
    const range = ranges.get(commentId(ref) ?? '');
    if (range && highlights) highlights.set(ACTIVE_COMMENT_HIGHLIGHT, new Highlight(range));
  };
  function hide() {
    window.clearTimeout(hideTimer);
    if (!shown) return;
    shown.classList.remove('is-active');
    shown.removeAttribute('aria-describedby');
    shown = undefined;
    pinned = false;
    card.hidden = true;
    highlights?.delete(ACTIVE_COMMENT_HIGHLIGHT);
  }
  // Leaving the 💬 for the card crosses a small gap; a short delay keeps the card while the pointer moves over.
  const hideSoon = () => {
    if (pinned) return;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 150);
  };
  const refOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(COMMENT_REF) : null);

  host.addEventListener('pointerover', event => { const ref = refOf(event.target); if (ref && !pinned) show(ref); });
  host.addEventListener('pointerout', event => { if (refOf(event.target) && !card.contains(event.relatedTarget as Node | null)) hideSoon(); });
  card.addEventListener('pointerover', () => window.clearTimeout(hideTimer));
  card.addEventListener('pointerout', event => { if (!card.contains(event.relatedTarget as Node | null) && refOf(event.relatedTarget) !== shown) hideSoon(); });
  host.addEventListener('focusin', event => { const ref = refOf(event.target); if (ref && !pinned) show(ref); });
  host.addEventListener('focusout', event => { if (refOf(event.target) && !pinned) hide(); });
  host.addEventListener('click', event => {
    const ref = refOf(event.target);
    if (!ref) return;
    event.stopPropagation();
    if (pinned && shown === ref) { hide(); return; }
    show(ref);
    pinned = true;
  });
  host.addEventListener('keydown', event => {
    const ref = refOf(event.target);
    if (!ref || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    ref.click();
  });
  document.addEventListener('click', event => { if (pinned && !card.contains(event.target as Node | null)) hide(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  window.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place);
}

async function main() {
  try {
    const response = await fetch('/document', { cache: 'no-store' });
    if (!response.ok) throw new Error(`document fetch failed: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    try {
      await renderAsync(buffer, host, undefined, DOCX_OPTIONS);
    } catch {
      // docx-preview 0.4.1 throws on some comments (one without `w:author` renders a null child). A document that
      // opened before comments were turned on must still open: show it without comments.
      host.replaceChildren();
      await renderAsync(buffer, host, undefined, { ...DOCX_OPTIONS, renderComments: false });
    }
    filterLinkedImages();
    setupComments();
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
