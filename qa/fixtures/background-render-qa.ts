// Browser bundle injected by appearance-backgrounds-visual.mjs.  It deliberately
// exposes only the D1 import/bake API needed to prepare renderer-owned fixtures.
import {
  ensureBlurVariant,
  importBackgroundFromBytes,
  listBackgroundImages,
} from '../../renderer/src/appearance/backgroundPipeline';
import { backgroundImageIdPattern } from '../../renderer/src/themes';

Object.assign(globalThis, {
  __ttBackgroundRenderQa: { ensureBlurVariant, importBackgroundFromBytes, listBackgroundImages, backgroundImageIdPattern },
});
