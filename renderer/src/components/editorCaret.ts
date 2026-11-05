
type Rgb = readonly [number, number, number];

const minimumContrast = 3;

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: Rgb): number {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

export function caretContrast(left: Rgb, right: Rgb): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

export function parseCaretColor(value: string): Rgb | undefined {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return [
    Number.parseInt(hex[1].slice(0, 2), 16),
    Number.parseInt(hex[1].slice(2, 4), 16),
    Number.parseInt(hex[1].slice(4, 6), 16),
  ];
  const channels = /^rgba?\(\s*([\d.]+)[,\s]+\s*([\d.]+)[,\s]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?/i.exec(value.trim());
  if (!channels) return undefined;
  const red = Number(channels[1]), green = Number(channels[2]), blue = Number(channels[3]);
  if (channels[4] !== undefined && Number(channels[4]) === 0) return undefined;
  return [red, green, blue].every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255) ? [red, green, blue] : undefined;
}

/** Uses the editor text when it is legible, then black/white as reliable fallbacks for adverse custom palettes. */
export function caretColorForSurface(surface: string, text: string): string {
  const background = parseCaretColor(surface);
  if (!background) return text;
  const candidates = [text, '#000000', '#ffffff'];
  let selected = candidates[0];
  let contrast = -1;
  for (const candidate of candidates) {
    const rgb = parseCaretColor(candidate);
    if (!rgb) continue;
    const next = caretContrast(background, rgb);
    if (next > contrast) {
      selected = candidate;
      contrast = next;
    }
  }
  return contrast >= minimumContrast ? selected : text;
}

function surfaceFor(element: HTMLElement): string | undefined {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const background = getComputedStyle(node).backgroundColor;
    if (parseCaretColor(background)) return background;
  }
  return undefined;
}

/**
 * Updates a single CSS variable only; CodeMirror keeps its document, selection and history instance intact.
 * Root token changes are synchronous style mutations, so observe the root rather than coupling to React theme state.
 */
export function installEditorCaretPresentation(host: HTMLElement): () => void {
  const apply = () => {
    const surface = surfaceFor(host);
    const text = getComputedStyle(host).color;
    host.style.setProperty('--tt-editor-caret', caretColorForSurface(surface ?? text, text));
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-custom-theme'] });
  return () => {
    observer.disconnect();
    host.style.removeProperty('--tt-editor-caret');
  };
}

