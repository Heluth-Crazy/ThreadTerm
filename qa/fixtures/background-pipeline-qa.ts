// QA entry for qa/background-images-pipeline.mjs: bundles the renderer's background pipeline, the theme pack format
// and the background maths into one script that the harness injects into the real app page (CDP evaluation is not
// governed by the app's CSP).
import {
  backgroundImageUrl,
  bakeBlurVariant,
  ensureBlurVariant,
  importBackgroundFromBytes,
  importBackgroundFromPath,
  importBackgroundFromPicker,
  listBackgroundImages,
  prepareBackgroundImage,
  pruneBackgroundImages,
  removeBackgroundImage,
} from '../../renderer/src/appearance/backgroundPipeline';
import {
  customCopyName,
  customThemeFromResolved,
  placement,
  referencedImageIds,
  regionRole,
  resolveBackgrounds,
} from '../../renderer/src/appearance/backgrounds';
import { encodeBase64, importThemePack, parseThemePack, storePackImages } from '../../renderer/src/appearance/themePack';
import { customTokens, resolveTheme } from '../../renderer/src/themes';

Object.assign(globalThis, {
  __ttBackground: {
    backgroundImageUrl,
    bakeBlurVariant,
    ensureBlurVariant,
    importBackgroundFromBytes,
    importBackgroundFromPath,
    importBackgroundFromPicker,
    listBackgroundImages,
    prepareBackgroundImage,
    pruneBackgroundImages,
    removeBackgroundImage,
    customCopyName,
    customThemeFromResolved,
    placement,
    referencedImageIds,
    regionRole,
    resolveBackgrounds,
    encodeBase64,
    importThemePack,
    parseThemePack,
    storePackImages,
    customTokens,
    resolveTheme,
  },
});
