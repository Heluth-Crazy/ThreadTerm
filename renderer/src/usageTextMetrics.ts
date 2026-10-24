// Label widths for the Usage charts. The renderer measures real text with a canvas so axis labels can be thinned
// without guessing; without a DOM (unit tests) the same call returns a deterministic estimate instead.

/** Matches the chart label font size; the family mirrors the app's UI stack closely enough for thinning. */
export const CHART_LABEL_FONT = '10px system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif';

const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
const ESTIMATE_RATIO = 0.58;
const CACHE_LIMIT = 512;

let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Width of `text` in CSS pixels at the chart label font, or a stable estimate when there is no canvas. */
export function labelWidth(text: string, font: string = CHART_LABEL_FONT): number {
  const key = `${font}\u0000${text}`;
  const cached = widths.get(key);
  if (cached !== undefined) return cached;
  if (context === undefined) {
    context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    if (context) context.font = font;
  }
  let width: number;
  const size = Number.parseFloat(font) || 10;
  if (context) {
    if (context.font !== font) context.font = font;
    width = context.measureText(text).width;
  } else {
    width = [...text].reduce((sum, char) => sum + (WIDE_CHAR.test(char) ? size : size * ESTIMATE_RATIO), 0);
  }
  if (widths.size >= CACHE_LIMIT) widths.clear();
  widths.set(key, width);
  return width;
}
