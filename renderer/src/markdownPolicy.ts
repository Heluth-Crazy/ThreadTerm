import DOMPurify from 'dompurify';

// One sanitizer policy for every surface that renders untrusted Markdown (live Chat, history replay, plan
// review, group chat, Markdown file preview). Untrusted text must never restyle, hide or spoof a control
// outside its own message, so stylesheets, inline styles, active elements, remote form targets and app CSS
// classes are removed here instead of per call site. Mermaid (SVG profile) and KaTeX keep their own
// constrained renderers; they never render raw model HTML.
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
};

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
  return restrictMarkdownClasses(String(sanitized));
}
