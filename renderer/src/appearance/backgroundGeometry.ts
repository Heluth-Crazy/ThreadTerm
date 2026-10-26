import type { PlacementBox } from './backgrounds';

export interface BackgroundShape {
  panel: PlacementBox;
  tab?: PlacementBox;
  box: PlacementBox;
  cutLeft: number;
  cutRight: number;
  feet: string;
}

/** One image placement spans the card, selected tab and the two concave feet. */
export function backgroundShape(panel: PlacementBox, tab?: PlacementBox): BackgroundShape {
  if (!tab) return { panel, box: panel, cutLeft: -20, cutRight: -10, feet: '' };
  const left = Math.max(panel.x + 8, tab.x), right = Math.min(panel.x + panel.w - 8, tab.x + tab.w);
  if (right <= left) return backgroundShape(panel);
  const clipped = { ...tab, x: left, w: right - left };
  const top = Math.min(panel.y, tab.y);
  return {
    panel, tab: clipped, box: { x: panel.x, y: top, w: panel.w, h: panel.y + panel.h - top },
    cutLeft: left - panel.x - 8, cutRight: right - panel.x + 8,
    feet: `M ${left - 8} ${panel.y + .5} A 8 8 0 0 0 ${left + .5} ${panel.y - 8} M ${right - .5} ${panel.y - 8} A 8 8 0 0 0 ${right + 8} ${panel.y + .5}`,
  };
}

export function tabShape({ panel, tab }: BackgroundShape): string {
  if (!tab) return '';
  const l = tab.x, r = tab.x + tab.w, t = tab.y, b = panel.y + 1;
  return `M ${l - 8} ${b} A 8 8 0 0 0 ${l} ${b - 8} V ${t + 8} Q ${l} ${t} ${l + 8} ${t} H ${r - 8} Q ${r} ${t} ${r} ${t + 8} V ${b - 8} A 8 8 0 0 0 ${r + 8} ${b} Z`;
}

/** Segmented top edge: the translucent tab never has a border underneath it. */
export function panelBorder({ panel, tab, cutLeft, cutRight }: BackgroundShape): string {
  const l = panel.x + .5, r = panel.x + panel.w - .5, t = panel.y + .5, b = panel.y + panel.h - .5, radius = 7.5;
  const start = tab ? Math.min(r - radius, panel.x + cutRight) : l + radius;
  const end = tab ? Math.max(l + radius, panel.x + cutLeft) : l + radius;
  return `M ${start} ${t} H ${r - radius} Q ${r} ${t} ${r} ${t + radius} V ${b - radius} Q ${r} ${b} ${r - radius} ${b} H ${l + radius} Q ${l} ${b} ${l} ${b - radius} V ${t + radius} Q ${l} ${t} ${l + radius} ${t} H ${end}`;
}

export function tabBorder({ panel, tab }: BackgroundShape): string {
  if (!tab) return '';
  const l = tab.x + .5, r = tab.x + tab.w - .5, t = tab.y + .5, b = panel.y + .5;
  return `M ${l - 8} ${b} A 8 8 0 0 0 ${l} ${b - 8} V ${t + 7.5} Q ${l} ${t} ${l + 7.5} ${t} H ${r - 7.5} Q ${r} ${t} ${r} ${t + 7.5} V ${b - 8} A 8 8 0 0 0 ${r + 8} ${b}`;
}
