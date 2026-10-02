import { readFile } from 'node:fs/promises';
import { startHarness, enter, act, screenshot, assertHealthy, assert } from './harness.mjs';

const harness = await startHarness();
const sourceMetrics = JSON.parse(await readFile(new URL('../preview/v3/source-frame-metrics.json', import.meta.url), 'utf8'));
const comparisons = [];

async function setTheme(page, theme) {
  await act(page, 'open-settings');
  await act(page, 'settings-open');
  await act(page, 'settings-section', { section: 'appearance' });
  await act(page, 'settings-theme', { theme });
  await act(page, 'settings-close');
}

async function projectOverview(page) {
  await act(page, 'open-project', { project: 'orbit' });
  await page.waitForURL(/#\/project\/orbit$/);
  await page.getByRole('heading', { name: 'orbit-web', exact: true }).waitFor({ state: 'visible' });
}

async function measureFrame(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      desktop: rect('.desktop'),
      window: rect('.app-window'),
      chrome: rect('.app-chrome'),
      shell: rect('.shell'),
      sidebar: rect('.sidebar'),
      main: rect('main'),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      verticalOverflow: document.documentElement.scrollHeight > innerHeight + 1,
    };
  });
}

function relative(region, origin) {
  if (!region || !origin) return null;
  return { x: region.x - origin.x, y: region.y - origin.y, width: region.width, height: region.height };
}

function compareFrame(width, height, theme, actual) {
  const source = sourceMetrics.find((entry) => entry.width === width && entry.height === height);
  const shell = source?.regions.find((region) => region.class === 'shell');
  const sidebar = source?.regions.find((region) => region.class === 'sidebar');
  const main = source?.regions.find((region) => region.tag === 'MAIN');
  const expected = {
    sidebar: relative(sidebar, shell),
    main: relative(main, shell),
  };
  const actualRel = {
    sidebar: relative(actual.sidebar, actual.shell),
    main: relative(actual.main, actual.shell),
  };
  const deviations = [];
  for (const region of ['sidebar', 'main']) {
    for (const field of ['x', 'y']) {
      const delta = actualRel[region]?.[field] - expected[region]?.[field];
      if (Math.abs(delta) > 1) deviations.push(`${region}.${field}: ${delta}px`);
    }
  }
  if (Math.abs((actualRel.sidebar?.width ?? 0) - 240) > 1) deviations.push(`sidebar.width: ${(actualRel.sidebar?.width ?? 0) - 240}px`);
  if (Math.abs((actualRel.main?.x ?? 0) - 240) > 1) deviations.push(`main.x: ${(actualRel.main?.x ?? 0) - 240}px`);
  if (!actual.window || actual.window.width < 200) deviations.push('app-window missing');
  if (!actual.chrome || actual.chrome.height < 24) deviations.push('app-chrome missing');
  const result = { width, height, theme, expected, actual: { ...actual, relative: actualRel }, deviations };
  comparisons.push(result);
  return result;
}

async function createChat(page) {
  await page.locator('[data-action="sessions-new"], [data-action="open-create"]').filter({ visible: true }).first().click();
  const form = page.locator('#v3-create-form');
  await form.locator('[data-create-agent="Codex"]').click();
  await form.locator('[data-create-mode="chat"]').click();
  await form.locator('input[name="name"]').fill('Visual approval');
  await page.getByRole('button', { name: '创建', exact: true }).click();
}

async function visualScenario(name, viewport, callback) {
  await harness.scenario(name, async () => {
    const { page, context, errors, requests } = await harness.newPage({ viewport });
    try {
      await enter(page, harness.origin);
      await callback(page);
      await assertHealthy(page, errors, requests);
    } finally {
      await context.close();
    }
  });
}

try {
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
    for (const theme of ['light', 'dark']) {
      await visualScenario(`project-overview-${theme}-${width}`, { width, height }, async (page) => {
        if (theme === 'dark') await setTheme(page, theme);
        await projectOverview(page);
        const frame = compareFrame(width, height, theme, await measureFrame(page));
        await screenshot(page, `v3-project-${theme}-${width}x${height}`);
        assert.equal(frame.actual.horizontalOverflow, false);
      });
    }
  }

  await visualScenario('editor-codemirror-1440', { width: 1440, height: 900 }, async (page) => {
    await act(page, 'open-session', { session: 'orbit-claude' });
    await act(page, 'ws-tab', { tab: 'file' });
    await page.locator('[data-testid="codemirror-editor"] .cm-content').waitFor({ state: 'visible' });
    await screenshot(page, 'v3-editor-codemirror-1440x900');
  });

  await visualScenario('chat-pending-approval-1440', { width: 1440, height: 900 }, async (page) => {
    await createChat(page);
    const form = page.locator('[data-v3-chat-form]');
    await form.locator('textarea').fill('Review the saved configuration.');
    await form.getByRole('button', { name: '发送', exact: true }).click();
    await page.locator('.v3-tool-card.pending').waitFor({ state: 'visible', timeout: 5000 });
    await screenshot(page, 'v3-chat-pending-approval-1440x900');
  });

  for (const theme of ['light', 'dark']) {
    await visualScenario(`settings-${theme}-1440`, { width: 1440, height: 900 }, async (page) => {
      await setTheme(page, theme);
      await act(page, 'open-settings');
      await act(page, 'settings-open');
      await act(page, 'settings-section', { section: 'appearance' });
      await screenshot(page, `v3-settings-${theme}-1440x900`);
    });
  }

  await visualScenario('workspace-four-pane-1440', { width: 1440, height: 900 }, async (page) => {
    await act(page, 'open-session', { session: 'orbit-claude' });
    while (await page.locator('.ws-tile').count() < 4) {
      await act(page, 'tile-open-add');
      const choice = page.locator('[data-action="tile-add"]').first();
      if (!await choice.count()) break;
      await choice.click();
    }
    assert.equal(await page.locator('.ws-tile').count(), 4);
    await screenshot(page, 'v3-workspace-four-pane-1440x900');
  });
} finally {
  harness.results.push({ name: 'source-frame-comparisons', status: comparisons.every((entry) => entry.deviations.length === 0) ? 'passed' : 'review', comparisons });
  await harness.finish('visuals-results.json');
}
