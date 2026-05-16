import type { CSSProperties } from 'react';
import type { DesktopPetSkin } from '../types/terminal';

/**
 * Cat fur palettes. Each skin maps to a set of CSS custom properties consumed
 * by the SVG gradients in `PetSprite`. The `theme` skin defers to the active
 * app theme so the pet matches the user's colour scheme.
 *
 * Keep the keys in sync with `DESKTOP_PET_SKINS` in `src/lib/petConfig.ts`.
 */
export interface PetSkinPalette {
  /** Top body gradient stop + highlight. */
  furLight: string;
  /** Mid body gradient stop. */
  furMid: string;
  /** Bottom body gradient stop + contact shadow. */
  furDark: string;
  /** Inner ear / paw pads. */
  earInner: string;
  /** Lighter face + belly patch. */
  belly: string;
  /** Outline stroke. */
  stroke: string;
}

export const PET_SKIN_PALETTES: Record<DesktopPetSkin, PetSkinPalette> = {
  classic: {
    furLight: '#F4F7FB',
    furMid: '#D7DEE8',
    furDark: '#AAB6C6',
    earInner: '#F6C5D3',
    belly: '#FCFDFF',
    stroke: '#8A98AB',
  },
  orange: {
    furLight: '#FFDCA6',
    furMid: '#FBB259',
    furDark: '#DE822A',
    earInner: '#FFD8C6',
    belly: '#FFF2DD',
    stroke: '#BE6A1E',
  },
  cream: {
    furLight: '#FFF7EC',
    furMid: '#F1E1C6',
    furDark: '#D4BD97',
    earInner: '#F6D2BD',
    belly: '#FFFEF9',
    stroke: '#B6A079',
  },
  tuxedo: {
    furLight: '#3C4150',
    furMid: '#262A33',
    furDark: '#13161D',
    earInner: '#E89BB0',
    belly: '#F5F7FB',
    stroke: '#0A0C11',
  },
  theme: {
    furLight: 'var(--theme-app-primary)',
    furMid: 'var(--theme-app-primary)',
    furDark: 'var(--theme-app-accent)',
    earInner: 'var(--theme-app-accent)',
    belly: 'var(--theme-app-background)',
    stroke: 'var(--theme-app-border)',
  },
};

/** Inline CSS custom properties for a skin, applied on the sprite root. */
export function petSkinStyle(skin: DesktopPetSkin): CSSProperties {
  const p = PET_SKIN_PALETTES[skin] ?? PET_SKIN_PALETTES.classic;
  return {
    '--pet-fur-light': p.furLight,
    '--pet-fur-mid': p.furMid,
    '--pet-fur-dark': p.furDark,
    '--pet-ear-inner': p.earInner,
    '--pet-belly': p.belly,
    '--pet-stroke': p.stroke,
  } as CSSProperties;
}
