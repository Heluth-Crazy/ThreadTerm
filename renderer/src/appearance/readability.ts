// Readability floor for background images (task 10-26 phase D): how much of a region's own colour the overlay must
// show on top of a background picture so every foreground keeps its contrast.
//
// Pure TypeScript, no DOM and no React: the folder can compute the floor from stored image statistics without a
// layout, the settings UI can preview it, and tests can stress it. The maths is the approved mockup's
// (`prototypes/appearance/index.html`, functions `foregrounds` and `floorFor`), generalised to take the palette and
// the statistics as arguments instead of reading global state.
import type { ImageStats, Rgb } from '../../../desktop/src/backgroundImagesCore';

/** The regions a theme can paint with an image. */
export type BackgroundRegion = 'window' | 'sidebar' | 'sidebar2' | 'chat' | 'editor' | 'terminal' | 'browser';

export interface ReadabilityTargets { text: number; muted: number }

/** Editor and terminal output need 7:1 for body text; every other surface 4.5:1 (WCAG AA). */
export function readabilityTargets(region: BackgroundRegion): ReadabilityTargets {
  return region === 'editor' || region === 'terminal' ? { text: 7, muted: 3 } : { text: 4.5, muted: 3 };
}

const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);
const byte = (value: number) => clamp(Math.round(value), 0, 255);

/** `#rgb` or `#rrggbb` to channels; undefined for anything else (the palette stores hex strings). */
export function parseColor(value: string): Rgb | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(text)) return [0, 1, 2].map(index => Number.parseInt(text.slice(index, index + 1).repeat(2), 16)) as Rgb;
  if (/^[0-9a-f]{6}$/i.test(text)) return [0, 2, 4].map(offset => Number.parseInt(text.slice(offset, offset + 2), 16)) as Rgb;
  return undefined;
}

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

/** WCAG 2.x contrast ratio (1–21) between two colours. */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const left = relativeLuminance(first), right = relativeLuminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/** `top` at `alpha` over `bottom` (sRGB, channel-wise like CSS compositing of opaque colours). */
export function mix(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  const t = clamp(alpha, 0, 1);
  return [byte(top[0] * t + bottom[0] * (1 - t)), byte(top[1] * t + bottom[1] * (1 - t)), byte(top[2] * t + bottom[2] * (1 - t))];
}

export interface ForegroundPalette {
  /** Body text colour. */
  text: string;
  /** Secondary text colour. */
  muted: string;
  /** Editor syntax colours; checked when the region is `editor`. */
  syn?: readonly string[];
  /** Terminal ANSI colours; ANSI 1–7 are checked when the region is `terminal`, like the mockup. */
  ansi?: readonly string[];
}

export interface ForegroundRequirement { color: Rgb; need: number }

/**
 * What each foreground needs from the surface behind it: text and secondary text their absolute target (never more
 * than they already have on the plain region colour), syntax and ANSI colours at most an 15 % loss of the contrast
 * they have on the plain region colour — a palette that is deliberately low-contrast stays that way.
 */
export function foregroundRequirements(palette: ForegroundPalette, regionColor: string, region: BackgroundRegion): ForegroundRequirement[] {
  const base = parseColor(regionColor);
  if (!base) throw new Error(`Invalid region colour: ${regionColor}`);
  const targets = readabilityTargets(region);
  const list: Array<{ color: Rgb; absolute: number }> = [];
  const text = parseColor(palette.text), muted = parseColor(palette.muted);
  if (!text || !muted) throw new Error('Invalid text palette');
  list.push({ color: text, absolute: targets.text }, { color: muted, absolute: targets.muted });
  if (region === 'editor') for (const value of palette.syn ?? []) { const color = parseColor(value); if (color) list.push({ color, absolute: 0 }); }
  if (region === 'terminal') for (const value of (palette.ansi ?? []).slice(1, 8)) { const color = parseColor(value); if (color) list.push({ color, absolute: 0 }); }
  return list.map(({ color, absolute }) => {
    const solid = contrastRatio(color, base);
    return { color, need: absolute > 0 ? Math.min(absolute, solid) : solid * 0.85 };
  });
}

export interface OverlayImage { stats: ImageStats; /** 0–1: how visible the picture is in this region. */ opacity: number }

export interface MinimumOverlayInput {
  /** The region's own colour (`editor`/`panel`/`sidebar`/`frame` depending on the region). */
  regionColor: string;
  /** The frame colour, which a window image sits on. */
  frameColor: string;
  image?: OverlayImage;
  /** `own`: the region has its own picture; `window`: it shows the window picture through its panel overlay. */
  source: 'own' | 'window';
  /** 0–1: the window overlay already applied above a region that inherits the window image. */
  windowOverlay?: number;
  requirements: readonly ForegroundRequirement[];
}

/**
 * The smallest region-colour overlay (0–1, in 0.01 steps) for which every requirement holds against the image's worst
 * pixels — composited under the image opacity, and under the window overlay when the region inherits the window image.
 * No image (or an image without statistics) needs no floor.
 */
export function minimumOverlay(input: MinimumOverlayInput): { floor: number } {
  const { image, requirements } = input;
  if (!image || requirements.length === 0) return { floor: 0 };
  const regionBase = parseColor(input.regionColor), frameBase = parseColor(input.frameColor);
  if (!regionBase || !frameBase) throw new Error('Invalid region or frame colour');
  const pixels = [...image.stats.dark, ...image.stats.bright];
  if (pixels.length === 0) return { floor: 0 };
  const opacity = clamp(image.opacity, 0, 1);
  const windowOverlay = input.source === 'window' ? clamp(input.windowOverlay ?? 0, 0, 1) : 0;
  const underImage = input.source === 'window' ? frameBase : regionBase;
  const under = pixels.map(pixel => {
    const composed = mix(pixel as Rgb, underImage, opacity);
    return windowOverlay > 0 ? mix(frameBase, composed, windowOverlay) : composed;
  });
  for (let step = 0; step <= 100; step += 1) {
    const alpha = step / 100;
    const surfaces = under.map(pixel => mix(regionBase, pixel, alpha));
    if (surfaces.every(surface => requirements.every(requirement => contrastRatio(requirement.color, surface) >= requirement.need))) {
      return { floor: Math.round(alpha * 100) / 100 };
    }
  }
  return { floor: 1 };
}
