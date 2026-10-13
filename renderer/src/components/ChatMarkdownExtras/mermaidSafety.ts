import DOMPurify from 'dompurify';

// Only these declarations and functions may survive. Everything else a
// diagram-level stylesheet or `style` attribute carries is dropped, so an
// agent-authored `%%{init}%%`/`themeCSS`/`classDef` cannot reach the document.
const ALLOWED_PROPERTIES = new Set([
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'fill-opacity', 'stroke-opacity', 'color', 'font-family', 'font-size', 'font-weight',
  'font-style', 'text-anchor', 'dominant-baseline', 'text-decoration', 'visibility', 'display',
]);
const ALLOWED_PROPERTY_PREFIXES = ['marker-'];
const ALLOWED_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'var']);

/** A declaration is kept only for an allowlisted property. */
export function isAllowedProperty(property: string): boolean {
  const name = property.trim().toLowerCase();
  if (!name) return false;
  return ALLOWED_PROPERTIES.has(name) || ALLOWED_PROPERTY_PREFIXES.some(prefix => name.startsWith(prefix));
}

/** A value may call only colour/`var` functions, and `url()` only for an in-document fragment. */
export function isSafeCssValue(value: string): boolean {
  const text = value.trim();
  if (!text || /[{}\\<]/.test(text)) return false;
  const stripped = text.replace(/url\(\s*(['"]?)#[^)'"]*\1\s*\)/gi, ' ');
  if (/url\s*\(/i.test(stripped)) return false;
  for (const match of stripped.matchAll(/([a-zA-Z-]+)\s*\(/g)) {
    if (!ALLOWED_FUNCTIONS.has(match[1].toLowerCase())) return false;
  }
  return true;
}

/** Parse `prop: value; …` and keep only allowlisted declarations with safe values. */
export function sanitizeDeclarationText(value: string): string {
  const kept: string[] = [];
  for (const part of value.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const property = part.slice(0, colon).trim();
    const declaration = part.slice(colon + 1).trim();
    if (!isAllowedProperty(property) || !isSafeCssValue(declaration)) continue;
    kept.push(`${property}: ${declaration}`);
  }
  return kept.join('; ');
}

/** A selector is kept only when it is anchored to the rendered diagram's own id. `scope` includes the leading `#`. */
export function isScopedSelector(selector: string, scope: string): boolean {
  const text = selector.trim();
  if (!scope || !text) return false;
  const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?![\\w-])`).test(text);
}

/** Allowlist a set of already-parsed CSS rules; only the diagram's own subtree survives. */
export function sanitizeCssRules(rules: ReadonlyArray<{ selectorText: string; declarations: string }>, scope: string): string {
  const kept: string[] = [];
  for (const rule of rules) {
    const selectors = rule.selectorText.split(',').map(part => part.trim()).filter(Boolean);
    if (!selectors.length || !selectors.every(selector => isScopedSelector(selector, scope))) continue;
    const declarations = sanitizeDeclarationText(rule.declarations);
    if (declarations) kept.push(`${rule.selectorText} { ${declarations} }`);
  }
  return kept.join('\n');
}

/** Remove Mermaid directives and YAML frontmatter config before `mermaid.render`. */
export function stripMermaidDirectives(source: string): string {
  return source
    .replace(/%%\{[\s\S]*?\}%%[ \t]*\r?\n?/g, '')
    .replace(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

/** Parse a stylesheet with CSSOM, which refuses `@import`, then allowlist its rules. */
export function sanitizeCssText(css: string, scope: string): string {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const rules = Array.from(sheet.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .map(rule => ({ selectorText: rule.selectorText, declarations: rule.style.cssText }));
    return sanitizeCssRules(rules, scope);
  } catch {
    return '';
  }
}

/** Keep diagrams local and inert, including when their SVG is downloaded. */
export function safeMermaidSvg(svg: string, scope?: string): string {
  const safe = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'animate', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'src'] });
  const holder = document.createElement('div'); holder.innerHTML = safe;
  const id = scope ?? holder.firstElementChild?.getAttribute('id') ?? '';
  for (const element of Array.from(holder.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'style') {
        const clean = sanitizeDeclarationText(attribute.value);
        if (clean) element.setAttribute('style', clean); else element.removeAttribute('style');
        continue;
      }
      if (/url\(\s*['"]?(?!#)/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  for (const style of Array.from(holder.querySelectorAll('style'))) {
    const clean = id ? sanitizeCssText(style.textContent ?? '', `#${id}`) : '';
    if (clean) style.textContent = clean; else style.remove();
  }
  return holder.innerHTML;
}

