import DOMPurify from 'dompurify';

// One sanitizer policy for every surface that renders untrusted Markdown (live Chat, history replay, plan
// review, group chat, Markdown file preview). Untrusted text must never restyle, hide or spoof a control
// outside its own message, so stylesheets, inline styles, active elements, remote form targets and app CSS
// classes are removed here instead of per call site. Remote images become inert placeholders: rendering text
// never contacts the origin it names (F17). Mermaid (SVG profile) and KaTeX keep their own constrained
// renderers; they never render raw model HTML.
const forbiddenTags = [
  // active content and resource loaders
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  // document-level elements: a retained <style> restyles the whole app document
  'style', 'link', 'meta', 'base',
  // form controls and submit/navigation surfaces
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'fieldset',
  // media elements and overlays that cannot be contained
  'audio', 'video', 'source', 'track', 'dialog',
  // reserved for the Mermaid/Math renderers
  'svg', 'math',
];
// Style carriers, remote asset hints and form/navigation targets.
const forbiddenAttributes = ['style', 'srcset', 'background', 'poster', 'formaction', 'ping', 'srcdoc'];
// Classes marked may emit; app CSS targets none of them. Everything else is stripped so no message can
// claim an app class (for example .btn-primary) and impersonate or misstyle a real control.
const allowedClasses = new Set(['task-list', 'contains-task-list', 'task-list-item']);
const languageClass = /^language-[a-z0-9+#._-]{1,32}$/i;

/** The policy as data, so documentation and unit tests can assert it directly. */
export const markdownPolicyRules = Object.freeze({ forbiddenTags, forbiddenAttributes, allowedClasses });

export type MarkdownPolicyOptions = {
  /** Group chat shows no images: a remote <img> would be an unconditional request. */
  forbidImages?: boolean;
  /** History derives file references from hrefs, so injected metadata attributes are dropped. */
  forbidFileReferences?: boolean;
  /** Placeholder copy language; defaults to the app document language. */
  zh?: boolean;
};

/** The surface's language, taken from the document the app already localizes (App.tsx sets `lang`). */
export function markdownLanguage(zh?: boolean): boolean {
  return zh ?? (typeof document !== 'undefined' && document.documentElement.lang === 'zh-CN');
}

// A remote image is a request to a URL chosen by the text being rendered: while rendering, the policy keeps
// only its provenance, and the loader is the one place that turns a click into the request.
const remoteSourcePrefix = /^(?:https?:\/|\/\/)/i;

/** Absolute http(s) URL for a remote source, or undefined for data:, blob:, file: and workspace-relative sources. */
export function remoteImageLoadUrl(source: string | null | undefined): URL | undefined {
  const value = (source ?? '').trim();
  if (!remoteSourcePrefix.test(value)) return undefined;
  try {
    // Protocol-relative sources have no scheme of their own; https keeps the app's own origin out of it.
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Everything a remote-image placeholder shows and everything a click needs, decided without a DOM. */
export type InertRemoteImage = {
  /** The authored URL; inert data until the reader loads this image. */
  source: string;
  host: string;
  /** Present only for a well-formed http(s) source; a malformed one renders without a load action. */
  loadUrl?: string;
  alt: string;
  label: string;
  title: string;
  ariaLabel: string;
};

export function inertRemoteImage(src: string | null | undefined, alt: string | null | undefined, zh = markdownLanguage()): InertRemoteImage | undefined {
  const source = (src ?? '').trim();
  if (!remoteSourcePrefix.test(source)) return undefined;
  const url = remoteImageLoadUrl(source);
  const host = url?.host ?? '';
  return {
    source,
    host,
    ...(url ? { loadUrl: url.href } : {}),
    alt: (alt ?? '').trim() || (zh ? '图片' : 'Image'),
    label: zh ? '载入图片' : 'Load image',
    title: url ? (zh ? `从 ${host} 载入图片` : `Load image from ${host}`) : '',
    ariaLabel: host ? (zh ? `远端图片 ${host}` : `Remote image ${host}`) : (zh ? '远端图片' : 'Remote image'),
  };
}

const escapeHtmlText = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Our own inert markup: no src, no request. Rendered identically by the React and the DOM paths. */
export function remoteImagePlaceholderHtml(image: InertRemoteImage): string {
  return `<span class="md-remote-image" role="group" aria-label="${escapeHtmlText(image.ariaLabel)}"`
    + ` data-remote-image="${escapeHtmlText(image.source)}" data-remote-image-host="${escapeHtmlText(image.host)}">`
    + `<span class="md-remote-image-alt">${escapeHtmlText(image.alt)}</span>`
    + (image.host ? `<span class="md-remote-image-host">${escapeHtmlText(image.host)}</span>` : '')
    + (image.loadUrl ? `<button type="button" class="btn btn-sm md-remote-image-load" data-remote-image-load title="${escapeHtmlText(image.title)}">${escapeHtmlText(image.label)}</button>` : '')
    + '</span>';
}

/** Replaces each remote <img> in already sanitized HTML with its placeholder. Local images are untouched. */
function inertRemoteImages(html: string, zh: boolean): string {
  if (!html.includes('<img')) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  let replaced = false;
  for (const image of Array.from(template.content.querySelectorAll('img'))) {
    const source = image.getAttribute('src');
    if (!source?.trim()) {
      // No source survives (for example an image that only had srcset): it cannot show anything, so it goes.
      image.remove();
      replaced = true;
      continue;
    }
    const inert = inertRemoteImage(source, image.getAttribute('alt'), zh);
    if (!inert) continue;
    const holder = document.createElement('span');
    holder.innerHTML = remoteImagePlaceholderHtml(inert);
    image.replaceWith(...Array.from(holder.childNodes));
    replaced = true;
  }
  return replaced ? template.innerHTML : html;
}

/** Makes exactly the clicked image a request. Nothing is remembered, so a replay starts inert again. */
export function loadRemoteImage(target: Element): boolean {
  const placeholder = target.closest('[data-remote-image]');
  // The class cannot be forged: sanitization strips every class it does not generate itself.
  if (!(placeholder instanceof HTMLElement) || !placeholder.classList.contains('md-remote-image')) return false;
  const source = placeholder.dataset.remoteImage ?? '';
  const url = remoteImageLoadUrl(source);
  if (!url) return false;
  const image = document.createElement('img');
  image.className = 'md-remote-image-loaded';
  image.src = url.href;
  image.alt = placeholder.querySelector('.md-remote-image-alt')?.textContent ?? '';
  const host = placeholder.dataset.remoteImageHost ?? '';
  image.title = host ? (markdownLanguage() ? `从 ${host} 载入图片` : `Load image from ${host}`) : '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  placeholder.replaceWith(image);
  return true;
}

let remoteImageLoaderInstalled = false;
/**
 * One delegated listener for the surfaces that render sanitized HTML directly (plans, history, file preview).
 * The buttons only exist inside sanitized fragments, so nothing is wired per message and an idle page does nothing.
 */
export function installRemoteImageLoader(): void {
  if (remoteImageLoaderInstalled || typeof document === 'undefined') return;
  remoteImageLoaderInstalled = true;
  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-remote-image-load]')) return;
    if (loadRemoteImage(target)) event.preventDefault();
  });
}

export function markdownClassNameAllowed(className: string): boolean {
  return allowedClasses.has(className) || languageClass.test(className);
}

export function filterMarkdownClasses(value: string): string {
  return value.split(/\s+/).filter(name => name.length > 0 && markdownClassNameAllowed(name)).join(' ');
}

/** Re-serialize an already sanitized fragment with only allow-listed class names. */
export function restrictMarkdownClasses(html: string): string {
  // Most messages carry no class at all: skip the extra parse in that case.
  if (!html.includes('class=')) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll('[class]'))) {
    const kept = filterMarkdownClasses(element.getAttribute('class') ?? '');
    if (kept) element.setAttribute('class', kept);
    else element.removeAttribute('class');
  }
  return template.innerHTML;
}

export function sanitizeMarkdownHtml(html: string, options: MarkdownPolicyOptions = {}): string {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: options.forbidImages ? [...forbiddenTags, 'img'] : forbiddenTags,
    FORBID_ATTR: options.forbidFileReferences ? [...forbiddenAttributes, 'data-threadterm-file-reference'] : forbiddenAttributes,
    SANITIZE_NAMED_PROPS: true,
  });
  const restricted = restrictMarkdownClasses(String(sanitized));
  return options.forbidImages ? restricted : inertRemoteImages(restricted, markdownLanguage(options.zh));
}

installRemoteImageLoader();
