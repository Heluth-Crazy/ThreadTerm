import { startHarness, enter, act, screenshot, assert } from './harness.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { outputRoot } from './harness.mjs';

const harness = await startHarness();
const metrics = [];
try {
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
    await harness.scenario(`source-frame-${width}`, async () => {
      const { page, context, errors, requests } = await harness.newPage({ viewport: { width, height } });
      await enter(page, harness.origin, 'threadterm-app');
      await act(page, 'open-project', { project: 'orbit' });
      await screenshot(page, `source-project-${width}`);
      metrics.push({ width, height, route: page.url().split('#')[1], regions: await page.locator('#app > *, aside, main, .sidebar, .main').evaluateAll((nodes) => nodes.map((node) => { const rect = node.getBoundingClientRect(); return { tag: node.tagName, class: node.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })) });
      assert.deepEqual(errors.filter((error) => !error.includes('Content Security Policy')), []);
      assert.deepEqual(requests, []);
      await context.close();
    });
  }
  await writeFile(resolve(outputRoot, 'source-frame-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
} finally {
  await harness.finish('baseline-results.json');
}
