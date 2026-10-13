import assert from 'node:assert/strict';
import test from 'node:test';
import { diagramDimensions, diagramRasterSize } from './diagramGeometry';
test('100 percent diagram zoom uses SVG dimensions rather than fit width', () => {
  assert.deepEqual(diagramDimensions('<svg width="100%" viewBox="-10 0 800 400">'), { width: 800, height: 400 });
  assert.deepEqual(diagramDimensions('<svg viewBox="0 0 NaN 100">'), { width: 300, height: 150 });
});
test('PNG export bounds raster dimensions while preserving diagram aspect ratio', () => {
  assert.deepEqual(diagramRasterSize({ width: 8192, height: 4096 }), { width: 4096, height: 2048 });
  assert.deepEqual(diagramRasterSize({ width: 200, height: 100 }), { width: 200, height: 100 });
});
