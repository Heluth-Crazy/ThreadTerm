// QA entry for qa/background-images-pipeline.mjs: bundles the renderer's background pipeline into one script that the
// harness injects into the real app page (CDP evaluation is not governed by the app's CSP).
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
  },
});
