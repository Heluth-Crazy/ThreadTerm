// Background images for a resolved theme (task 10-26 phase D): which picture each region shows, how far its overlay has
// to dim it so every foreground keeps its contrast, where the picture sits, and how a preset becomes a custom copy when
// a background is added.
//
// Pure TypeScript, no DOM and no React: the appearance UI renders these values, the settings UI previews them and tests
// stress them. The maths is the approved mockup's (`prototypes/appearance/index.html`: `base`, `floorFor`, `placement`)
// on top of D1's `readability.ts` and the stored image records.
import type { BackgroundRecord, ImageStats } from '../../../desktop/src/backgroundImagesCore';
import {
  backgroundImageIdPattern,
  inheritBackgroundImage,
  themeBackgroundRegions,
  themeBackgrounds,
  type ResolvedTheme,
  type ThemeBackgroundLayer,
  type ThemeBackgroundRegion,
  type ThemeBackgrounds,
  type ThemeTokens,
} from '../themes';
import { backgroundImageUrl } from './backgroundPipeline';
import { foregroundRequirements, minimumOverlay, type BackgroundRegion } from './readability';

export type { BackgroundRegion };
/** The region ids, in the mockup's order (window first: every other region can inherit its picture). */
export const backgroundRegions: readonly BackgroundRegion[] = themeBackgroundRegions;

/** The colour a region sits on: frame, sidebar, panel or editor. */
export type RegionRole = 'frame' | 'sidebar' | 'panel' | 'editor';
const regionRoles: Record<BackgroundRegion, RegionRole> = {
  window: 'frame',
  sidebar: 'sidebar',
  sidebar2: 'panel',
  chat: 'panel',
  editor: 'editor',
  terminal: 'editor',
  browser: 'panel',
};
export function regionRole(region: BackgroundRegion): RegionRole {
  return regionRoles[region] ?? 'panel';
}

/** The theme colour behind a region's picture and overlay. */
export function regionColor(theme: ResolvedTheme, region: BackgroundRegion): string {
  return theme.colors[regionRole(region)];
}

/** What one region shows: its own picture, the window picture through its own overlay, or nothing. */
export interface ResolvedRegionBackground {
  region: BackgroundRegion;
  source: 'own' | 'window' | null;
  /** The layer supplying the picture (`own`: the region's; `window`: the window's). */
  layer?: ThemeBackgroundLayer;
  /** Served URL of the original or of the baked blur variant; undefined while the variant still has to be baked. */
  imageUrl?: string;
  /** The blur variant missing from the store, so the caller can bake it once (`ensureBlurVariant`). */
  needsBake?: { id: string; blur: number };
  /** 0–1: the region colour's opacity over the picture, never below `floor`. */
  overlay: number;
  /** 0–1: the smallest overlay that keeps every foreground readable on this picture. */
  floor: number;
  /** True when the floor raised the overlay the user chose for this region. */
  raised: boolean;
  /** The layer's image id whose record is gone from the store (the region falls back to the window picture). */
  missing?: string;
}
export type ResolvedBackgrounds = Record<BackgroundRegion, ResolvedRegionBackground>;

interface LayerImage {
  stats: ImageStats;
  url?: string;
  needsBake?: { id: string; blur: number };
}

/** The statistics and URL of the variant a layer shows; a blur that is not baked yet leaves `url` undefined. */
function layerImage(layer: ThemeBackgroundLayer, record: BackgroundRecord): LayerImage {
  if (layer.blur > 0) {
    const variant = record.variants?.[String(layer.blur)];
    return variant
      ? { stats: variant.stats, url: backgroundImageUrl(record.id, layer.blur) }
      : { stats: record.stats, needsBake: { id: record.id, blur: layer.blur } };
  }
  return { stats: record.stats, url: backgroundImageUrl(record.id) };
}

function requirementsFor(theme: ResolvedTheme, region: BackgroundRegion) {
  return foregroundRequirements(
    { text: theme.colors.text, muted: theme.colors.muted, syn: Object.values(theme.syn), ansi: theme.ansi },
    regionColor(theme, region),
    region,
  );
}

/**
 * Resolves every region of a theme. A region with its own, stored picture shows it and dims it with its own overlay; a
 * region whose layer says `inherit`, that has no layer at all, or whose picture vanished from the store shows the window
 * picture, and the window overlay — itself never below the window's floor — dims the picture before the region does. A
 * region without an entry only gets the floor; one that inherits through its own layer also gets the overlay chosen for
 * it. Every overlay is `max(chosen, floor)`, so the readability floor can only ever raise it.
 */
export function resolveBackgrounds(
  theme: ResolvedTheme,
  backgrounds: ThemeBackgrounds | undefined,
  records: readonly BackgroundRecord[],
): ResolvedBackgrounds {
  const wanted = themeBackgrounds(backgrounds);
  const byId = new Map(records.map(record => [record.id, record]));
  const windowLayer = wanted?.window;
  const windowRecord = windowLayer ? byId.get(windowLayer.image) : undefined;
  const windowImage = windowLayer && windowRecord ? layerImage(windowLayer, windowRecord) : undefined;
  const frameColor = theme.colors.frame;
  const windowFloor = windowLayer && windowImage
    ? minimumOverlay({
      regionColor: regionColor(theme, 'window'),
      frameColor,
      image: { stats: windowImage.stats, opacity: windowLayer.opacity / 100 },
      source: 'own',
      requirements: requirementsFor(theme, 'window'),
    }).floor
    : 0;
  const result = {} as ResolvedBackgrounds;
  for (const region of backgroundRegions) {
    const own = wanted?.[region];
    if (own && own.image === inheritBackgroundImage) {
      // The region only dims the window picture; opacity, blur, fit, focus and scale belong to the window layer.
      result[region] = inherit(region, own);
      continue;
    }
    const record = own ? byId.get(own.image) : undefined;
    if (own && !record) {
      // The theme still names the picture but the store lost it: ignore the layer, tell the UI, inherit like before.
      result[region] = inherit(region, undefined, own.image);
      continue;
    }
    if (!own || !record) {
      result[region] = inherit(region);
      continue;
    }
    const image = layerImage(own, record);
    const floor = minimumOverlay({
      regionColor: regionColor(theme, region),
      frameColor,
      image: { stats: image.stats, opacity: own.opacity / 100 },
      source: 'own',
      requirements: requirementsFor(theme, region),
    }).floor;
    const chosen = own.overlay / 100;
    result[region] = {
      region,
      source: 'own',
      layer: own,
      imageUrl: image.url,
      needsBake: image.needsBake,
      overlay: Math.max(chosen, floor),
      floor,
      raised: floor > chosen,
    };
  }
  return result;

  function inherit(region: BackgroundRegion, own?: ThemeBackgroundLayer, missing?: string): ResolvedRegionBackground {
    if (region === 'window' || !windowLayer || !windowImage) return { region, source: null, overlay: 0, floor: 0, raised: false, missing };
    const floor = minimumOverlay({
      regionColor: regionColor(theme, region),
      frameColor,
      image: { stats: windowImage.stats, opacity: windowLayer.opacity / 100 },
      source: 'window',
      windowOverlay: Math.max(windowLayer.overlay / 100, windowFloor),
      requirements: requirementsFor(theme, region),
    }).floor;
    const chosen = own ? own.overlay / 100 : 0;
    return {
      region,
      source: 'window',
      layer: windowLayer,
      imageUrl: windowImage.url,
      needsBake: windowImage.needsBake,
      overlay: Math.max(chosen, floor),
      floor,
      raised: own ? floor > chosen : false,
      missing,
    };
  }
}

/** A region's box on screen (CSS px, relative to the window). */
export interface PlacementBox { x: number; y: number; w: number; h: number }
export interface PlacementImage { width: number; height: number }
export interface Placement {
  /** `background-size`: `"<w>px <h>px"`. */
  size: string;
  /** `background-position` x/y in CSS px, relative to the region's origin. */
  x: number;
  y: number;
  repeat: 'no-repeat' | 'repeat';
}
/** A tiled picture keeps this width at scale 100 (the mockup's 320 px tile). */
export const TILE_WIDTH = 320;

const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const positive = (value: number, fallback = 1) => (Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * Where the picture sits inside a region: `cover`/`contain` scale the picture to the box and shift it by the focus
 * point (0 = left/top, 50 = centred, 100 = right/bottom); `tile` repeats it at a fixed tile width and ignores the focus
 * point. `scale` (50–200 %) multiplies the fitted size.
 */
export function placement(
  layer: Pick<ThemeBackgroundLayer, 'fit' | 'focusX' | 'focusY' | 'scale'>,
  box: PlacementBox,
  image: PlacementImage,
): Placement {
  const width = positive(image.width), height = positive(image.height);
  const x = finite(box.x), y = finite(box.y), w = Math.max(0, finite(box.w)), h = Math.max(0, finite(box.h));
  const scale = Math.max(1, finite(layer.scale, 100)) / 100;
  if (layer.fit === 'tile') {
    const tile = TILE_WIDTH * scale;
    return { size: `${tile}px ${(tile * height) / width}px`, x, y, repeat: 'repeat' };
  }
  const base = layer.fit === 'cover' ? Math.max(w / width, h / height) : Math.min(w / width, h / height);
  const drawn = { width: width * base * scale, height: height * base * scale };
  return {
    size: `${drawn.width}px ${drawn.height}px`,
    x: x + (w - drawn.width) * (Math.max(0, Math.min(100, finite(layer.focusX, 50))) / 100),
    y: y + (h - drawn.height) * (Math.max(0, Math.min(100, finite(layer.focusY, 50))) / 100),
    repeat: 'no-repeat',
  };
}

/** `Tokyo Night (custom)`, then `(custom 2)`, `(custom 3)` … skipping names that are taken. */
export function customCopyName(presetName: string, existingNames: readonly string[]): string {
  const trimmed = typeof presetName === 'string' ? presetName.trim() : '';
  const root = trimmed.replace(/ \(custom(?: [1-9][0-9]*)?\)$/, '').trim() || trimmed || 'Custom';
  const taken = new Set(existingNames);
  const first = `${root} (custom)`;
  if (!taken.has(first)) return first;
  // Every candidate is distinct and the taken set is finite, so this ends on a free name.
  for (let index = 2; ; index += 1) {
    const next = `${root} (custom ${index})`;
    if (!taken.has(next)) return next;
  }
}

/** The custom theme that carries a preset's palette plus backgrounds: all eight role colours, the base preset id. */
export function customThemeFromResolved(resolved: ResolvedTheme, backgrounds?: ThemeBackgrounds): ThemeTokens {
  const colors = resolved.colors;
  const tokens: ThemeTokens = {
    background: colors.frame,
    surface: colors.panel,
    text: colors.text,
    muted: colors.muted,
    accent: colors.accent,
    border: colors.border,
    sidebar: colors.sidebar,
    editor: colors.editor,
    base: resolved.presetId,
  };
  // Re-validate: a theme that cannot be stored must never be built from uncontrolled state.
  const kept = themeBackgrounds(backgrounds);
  if (kept) tokens.backgrounds = kept;
  return tokens;
}

/** Every image id the given custom themes reference (the keep list for `pruneBackgroundImages`). */
export function referencedImageIds(themes: Record<string, ThemeTokens | undefined> | undefined | null): Set<string> {
  const ids = new Set<string>();
  for (const theme of Object.values(themes ?? {})) {
    const backgrounds = themeBackgrounds(theme?.backgrounds);
    if (!backgrounds) continue;
    for (const layer of Object.values(backgrounds)) if (layer && backgroundImageIdPattern.test(layer.image)) ids.add(layer.image);
  }
  return ids;
}
