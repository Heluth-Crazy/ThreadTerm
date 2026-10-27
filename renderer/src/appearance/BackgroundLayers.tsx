import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BackgroundRecord } from '../../../desktop/src/backgroundImagesCore';
import type { ResolvedTheme, ThemeBackgrounds } from '../themes';
import { ensureBlurVariant, listBackgroundImages } from './backgroundPipeline';
import { placement, regionColor, resolveBackgrounds, type BackgroundRegion, type PlacementBox } from './backgrounds';
import { backgroundShape, panelBorder, tabShape, type BackgroundShape } from './backgroundGeometry';
import { backgroundLayoutEvent, setTerminalBackground } from './backgroundState';
import './background-layers.css';

const pendingBakes = new Map<string, Promise<BackgroundRecord>>();
function baked(record: BackgroundRecord, blur: number) {
  const key = `${record.id}:${blur}`;
  let result = pendingBakes.get(key);
  if (!result) {
    result = ensureBlurVariant(record, blur).finally(() => pendingBakes.delete(key));
    pendingBakes.set(key, result);
  }
  return result;
}

interface RegionGeometry { key: string; region: BackgroundRegion; shape: BackgroundShape; radius: number }
interface Geometry { width: number; height: number; regions: RegionGeometry[] }

/** Loaded only for themes with backgrounds. All layout work is driven by explicit layout/resize/scroll events. */
export default function BackgroundLayers({ theme, backgrounds, layoutKey }: { theme: ResolvedTheme; backgrounds: ThemeBackgrounds; layoutKey: string }) {
  const host = useRef<SVGSVGElement>(null);
  const id = useId().replace(/:/g, '');
  const [records, setRecords] = useState<BackgroundRecord[]>([]);
  const [geometry, setGeometry] = useState<Geometry>({ width: 0, height: 0, regions: [] });
  const resolved = useMemo(() => resolveBackgrounds(theme, backgrounds, records), [theme, backgrounds, records]);
  const schedule = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void listBackgroundImages().then(async stored => {
      const wanted = resolveBackgrounds(theme, backgrounds, stored);
      const needs = new Map(Object.values(wanted).flatMap(region => region.needsBake ? [[`${region.needsBake.id}:${region.needsBake.blur}`, region.needsBake] as const] : []));
      if (live) setRecords(stored);
      if (!needs.size) return;
      const updated = await Promise.allSettled([...needs.values()].map(need => baked(stored.find(record => record.id === need.id)!, need.blur)));
      if (!live) return;
      const byId = new Map(stored.map(record => [record.id, record]));
      for (const result of updated) if (result.status === 'fulfilled') {
        const previous = byId.get(result.value.id);
        byId.set(result.value.id, { ...result.value, variants: { ...previous?.variants, ...result.value.variants } });
      }
      setRecords([...byId.values()]);
    }).catch(() => { if (live) setRecords([]); });
    return () => { live = false; };
  }, [theme, backgrounds]);
  useLayoutEffect(() => {
    const shell = host.current?.parentElement;
    if (!shell) return;
    if (!Object.values(resolved).some(region => region.imageUrl)) return;
    let frame: number | undefined;
    const marked = new Set<HTMLElement>();
    const observed = new Set<Element>();
    const observer = new ResizeObserver(() => queue());
    const usable = (region: BackgroundRegion) => Boolean(resolved[region].imageUrl);
    const mark = (element: HTMLElement, region: BackgroundRegion) => {
      if (element.dataset.backgroundRegion !== region) element.dataset.backgroundRegion = region;
      marked.add(element);
    };
    const measure = () => {
      frame = undefined;
      const origin = shell.getBoundingClientRect();
      const rect = (element: Element): PlacementBox => {
        const r = element.getBoundingClientRect();
        return { x: r.left - origin.left - shell.clientLeft, y: r.top - origin.top - shell.clientTop, w: r.width, h: r.height };
      };
      const visible = (element: HTMLElement) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      const nextMarked = new Set<HTMLElement>(), targets = new Set<Element>([shell]);
      const regions: RegionGeometry[] = [];
      const add = (element: HTMLElement, region: BackgroundRegion, panel: HTMLElement, tab?: HTMLElement, radius = 8) => {
        targets.add(element); targets.add(panel); if (tab) targets.add(tab);
        if (!usable(region) || !visible(element)) return;
        mark(element, region); nextMarked.add(element);
        const panelBox = rect(panel);
        let tabBox = tab && visible(tab) ? rect(tab) : undefined;
        if (tabBox) {
          const strip = tab!.closest('.workspace-tabs');
          if (strip) { const clip = rect(strip); const right = Math.min(tabBox.x + tabBox.w, clip.x + clip.w); tabBox = { ...tabBox, x: Math.max(tabBox.x, clip.x), w: right - Math.max(tabBox.x, clip.x) }; }
        }
        const shape = backgroundShape(panelBox, tabBox);
        regions.push({ key: element.dataset.paneId ?? region, region, shape, radius });
      };
      const sidebar = shell.querySelector<HTMLElement>(':scope > .sidebar');
      if (sidebar) add(sidebar, 'sidebar', sidebar, undefined, 0);
      for (const panel of shell.querySelectorAll<HTMLElement>('.wb-sidebar > .wb-panel')) add(panel, 'sidebar2', panel);
      for (const pane of shell.querySelectorAll<HTMLElement>('.workspace-pane')) {
        const panel = pane.querySelector<HTMLElement>(':scope > .pane-card');
        const region = pane.dataset.appearanceRegion as BackgroundRegion | undefined;
        if (panel && region) add(pane, region, panel, pane.querySelector<HTMLElement>('.workspace-tab.active') ?? undefined);
      }
      for (const element of marked) if (!nextMarked.has(element)) { delete element.dataset.backgroundRegion; marked.delete(element); }
      for (const target of targets) if (!observed.has(target)) { observer.observe(target); observed.add(target); }
      for (const target of observed) if (!targets.has(target)) { observer.unobserve(target); observed.delete(target); }
      shell.toggleAttribute('data-window-background', usable('window'));
      shell.toggleAttribute('data-has-backgrounds', regions.length > 0 || usable('window'));
      const next = { width: shell.clientWidth, height: shell.clientHeight, regions };
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const queue = () => { if (frame === undefined) frame = requestAnimationFrame(measure); };
    schedule.current = queue;
    measure();
    shell.addEventListener('scroll', queue, true);
    document.addEventListener(backgroundLayoutEvent, queue);
    document.fonts.addEventListener('loadingdone', queue);
    window.addEventListener('resize', queue);
    setTerminalBackground(usable('terminal'));
    return () => {
      schedule.current = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      shell.removeEventListener('scroll', queue, true);
      document.removeEventListener(backgroundLayoutEvent, queue);
      document.fonts.removeEventListener('loadingdone', queue);
      window.removeEventListener('resize', queue);
      for (const element of marked) delete element.dataset.backgroundRegion;
      shell.removeAttribute('data-window-background'); shell.removeAttribute('data-has-backgrounds');
      setTerminalBackground(false);
    };
  }, [resolved]);
  useLayoutEffect(() => { schedule.current?.(); }, [layoutKey]);
  const paint = (region: BackgroundRegion, key: string, shape: BackgroundShape, radius: number) => {
    const value = resolved[region];
    if (!value.imageUrl || !value.layer) return null;
    const own = value.source === 'own', record = records.find(record => record.id === value.layer!.image);
    if (!record) return null;
    const picture = value.layer.blur > 0 ? record.variants[String(value.layer.blur)] ?? record : record;
    const p = placement(value.layer, shape.box, picture), [width, height] = p.size.split(' ').map(parseFloat);
    const clip = `${id}-${key}`, tile = `${clip}-tile`, color = regionColor(theme, region);
    const pane = !['window','sidebar','sidebar2'].includes(region);
    return <g key={key} data-background-layer={region} data-overlay={value.overlay} data-floor={value.floor} data-source={value.source}>
      <defs><clipPath id={clip}><rect x={shape.panel.x} y={shape.panel.y} width={shape.panel.w} height={shape.panel.h} rx={radius}/>{shape.tab && <path d={tabShape(shape)}/>}</clipPath>
        {own && p.repeat === 'repeat' && <pattern id={tile} patternUnits="userSpaceOnUse" x={p.x} y={p.y} width={width} height={height}><image href={value.imageUrl} width={width} height={height} preserveAspectRatio="none"/></pattern>}
      </defs>
      <g clipPath={`url(#${clip})`}>
        {own && <><rect width="100%" height="100%" fill={color}/>{p.repeat === 'repeat' ? <rect width="100%" height="100%" fill={`url(#${tile})`} opacity={value.layer.opacity / 100}/> : <image href={value.imageUrl} x={p.x} y={p.y} width={width} height={height} opacity={value.layer.opacity / 100} preserveAspectRatio="none"/>}</>}
        <rect width="100%" height="100%" fill={color} opacity={value.overlay}/>
        {pane && <rect data-background-lift="" width="100%" height="100%" fill={color} opacity={theme.mode === 'dark' ? 0.75 : 0.5}/>}
      </g>
      {pane && <path data-background-border="" d={panelBorder(shape)} fill="none" stroke="var(--border)" strokeWidth="1"/>}
    </g>;
  };
  return <svg ref={host} className="appearance-backgrounds" aria-hidden="true" data-ready={records.length > 0} width="100%" height="100%">
    {paint('window', 'window', backgroundShape({ x: 0, y: 0, w: geometry.width, h: geometry.height }), 0)}
    {geometry.regions.map(item => paint(item.region, item.key, item.shape, item.radius))}
  </svg>;
}
