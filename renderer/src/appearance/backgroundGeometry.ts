import type { PlacementBox } from './backgrounds';

export interface BackgroundShape {
  panel: PlacementBox;
  tab?: PlacementBox;
  /** Legacy backgrounds use 8px; flush panes explicitly opt into 0. */
  radius: number;
  box: PlacementBox;
  cutLeft: number;
  cutRight: number;
  feet: string;
}

/** One image placement spans the card, selected tab and the two concave feet. */
export function backgroundShape(panel: PlacementBox, tab?: PlacementBox, radius = 8): BackgroundShape {
  if (!tab) return { panel, radius, box: panel, cutLeft: -20, cutRight: -10, feet: '' };
  const left = Math.max(panel.x + radius, tab.x), right = Math.min(panel.x + panel.w - radius, tab.x + tab.w);
  if (right <= left) return backgroundShape(panel, undefined, radius);
  const clipped = { ...tab, x: left, w: right - left };
  const top = Math.min(panel.y, tab.y);
  return {
    panel, tab: clipped, radius, box: { x: panel.x, y: top, w: panel.w, h: panel.y + panel.h - top },
    cutLeft: left - panel.x - radius, cutRight: right - panel.x + radius,
    feet: radius ? `M ${left - radius} ${panel.y + .5} A ${radius} ${radius} 0 0 0 ${left + .5} ${panel.y - radius} M ${right - .5} ${panel.y - radius} A ${radius} ${radius} 0 0 0 ${right + radius} ${panel.y + .5}` : '',
  };
}

export function tabShape({ panel, tab, radius }: BackgroundShape): string {
  if (!tab) return '';
  const l = tab.x, r = tab.x + tab.w, t = tab.y, b = panel.y + 1;
  if (!radius) return `M ${l} ${b} V ${t} H ${r} V ${b} Z`;
  return `M ${l - radius} ${b} A ${radius} ${radius} 0 0 0 ${l} ${b - radius} V ${t + radius} Q ${l} ${t} ${l + radius} ${t} H ${r - radius} Q ${r} ${t} ${r} ${t + radius} V ${b - radius} A ${radius} ${radius} 0 0 0 ${r + radius} ${b} Z`;
}

/** Tabbed panels keep only the side and bottom hairlines; their top joins the selected tab by fill. */
export function panelBorder({ panel, tab }: BackgroundShape): string {
  const l = panel.x + .5, r = panel.x + panel.w - .5, t = panel.y + .5, b = panel.y + panel.h - .5, radius = 7.5;
  if (tab) return `M ${r} ${t + radius} V ${b - radius} Q ${r} ${b} ${r - radius} ${b} H ${l + radius} Q ${l} ${b} ${l} ${b - radius} V ${t + radius}`;
  return `M ${l + radius} ${t} H ${r - radius} Q ${r} ${t} ${r} ${t + radius} V ${b - radius} Q ${r} ${b} ${r - radius} ${b} H ${l + radius} Q ${l} ${b} ${l} ${b - radius} V ${t + radius} Q ${l} ${t} ${l + radius} ${t}`;
}
