import DOMPurify from 'dompurify';
/** Keep diagrams local and inert, including when their SVG is downloaded. */
export function safeMermaidSvg(svg: string): string {
  const safe = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'animate', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'src'] });
  const holder = document.createElement('div'); holder.innerHTML = safe;
  for (const element of Array.from(holder.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (/url\(\s*['"]?(?!#)/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  for (const style of Array.from(holder.querySelectorAll('style'))) {
    if (/@import|url\(\s*['"]?(?!#)/i.test(style.textContent ?? '')) style.remove();
  }
  return holder.innerHTML;
}
