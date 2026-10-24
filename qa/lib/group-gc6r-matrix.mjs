import assert from 'node:assert/strict';

const states = [
  { name:'added', details:[['deliverables/added.html', 'added', 'folder']] },
  { name:'modified', details:[['deliverables/modified.html', 'modified', 'folder']] },
  { name:'deleted', details:[['deliverables/deleted.html', 'deleted', 'folder']] },
  { name:'tool-only', details:[['deliverables/reported-only.txt', 'changed', 'tool']] },
  { name:'possibly', details:[['deliverables/owned.html', 'added', 'tool']], possible:['shared/overlap.html'], writers:['group-qa-b'] },
  { name:'incomplete', details:[['deliverables/partial.html', 'modified', 'folder']], incomplete:true },
  { name:'many', details:Array.from({ length:12 }, (_, index) => [`deliverables/many/file-${String(index + 1).padStart(2, '0')}.html`, index % 3 === 0 ? 'added' : index % 3 === 1 ? 'modified' : 'deleted', index % 2 ? 'tool' : 'folder']) },
];

const displayName = (locale, theme, width, state) => `group-changed-${state}-${locale}-${theme}-${width}`;

function outputFor(state) {
  const changedDetails = state.details.map(([path, status, evidence]) => ({ path, status, evidence }));
  return {
    files:['deliverables/output-a.html', 'deliverables/output-b.md'],
    urls:['http://127.0.0.1/group-output'],
    changed:changedDetails.map(detail => detail.path),
    changedDetails,
    ...(state.possible ? { possiblyChanged:state.possible, possiblyChangedWith:state.writers } : {}),
    ...(state.incomplete ? { changedIncomplete:true } : {}),
  };
}

async function settle(page, app, width) {
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 1200), width);
  await page.waitForFunction(value => innerWidth === value && innerHeight === 1200, width);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function installState(page, groupId, source, output) {
  await page.evaluate(({ groupId, source, output }) => {
    globalThis.__GC_QA_STATE__ = () => {
      const value = structuredClone(source);
      const reply = [...value.messages].reverse().find(message => message.author === 'member');
      if (reply) reply.outputs = output;
      return value;
    };
    globalThis.__GC_QA_REFRESH__(groupId);
  }, { groupId, source, output });
}

async function clearState(page, groupId) {
  await page.evaluate(id => {
    delete globalThis.__GC_QA_STATE__;
    globalThis.__GC_QA_REFRESH__(id);
  }, groupId);
}

/** Captures every Changed presentation state through the real Group reply UI. */
export async function captureGroupGc6rMatrix({ page, app, request, groupId, take, settings, check }) {
  const source = await request('group.read', { id:groupId });
  const sourceReply = [...source.messages].reverse().find(message => message.author === 'member');
  assert.ok(sourceReply, 'GC6r matrix requires a Group member reply');
  const reply = () => page.locator(`[data-message-id="${sourceReply.id}"]`);
  const metrics = [];

  try {
    for (const state of states) {
      for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1280, 900]) {
        await clearState(page, groupId);
        await settle(page, app, width);
        await settings(locale, theme);
        await installState(page, groupId, source, outputFor(state));
        await page.waitForTimeout(120);
        await reply().waitFor();
        const changed = reply().locator('details').filter({ hasText:locale === 'zh-CN' ? /已更改/ : /Changed:/ }).first();
        await changed.waitFor();
        if (!(await changed.evaluate(node => node.open))) await changed.locator('summary').click();
        await page.waitForTimeout(80);
        if (!(await changed.evaluate(node => node.open))) await changed.locator('summary').click();
        if (state.possible) {
          const possible = reply().locator('details').filter({ hasText:locale === 'zh-CN' ? /可能已更改/ : /Possibly changed/ }).first();
          await possible.waitFor();
          if (!(await possible.evaluate(node => node.open))) await possible.locator('summary').click();
        }
        await reply().evaluate(node => node.scrollIntoView({ block:'center', inline:'nearest' }));
        await page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
        const summaryBox = await changed.locator('summary').boundingBox();
        assert.ok(summaryBox && summaryBox.y >= 0 && summaryBox.y < 1200, `${state.name}/${locale}/${theme}/${width}: expanded Changed summary is in view`);
        const rows = reply().locator('.gc-changed-list .wb-change-row');
        await rows.first().waitFor();
        assert.equal(await rows.count(), state.details.length, `${state.name}/${locale}/${theme}/${width}: Changed rows preserve every detail`);
        if (['added', 'modified', 'deleted'].includes(state.name)) {
          assert.ok(await rows.first().evaluate((node, status) => node.classList.contains(`tone-${status}`), state.name), `${locale}/${theme}/${width}: ${state.name} row uses the shared workbench tone`);
          assert.equal(await rows.locator('.wb-deco').innerText(), state.name[0].toUpperCase(), `${locale}/${theme}/${width}: ${state.name} row has its status letter`);
        }
        if (state.name === 'deleted') assert.equal(await rows.locator('.gc-change-static').count(), 1, `${locale}/${theme}/${width}: deleted Changed row is not clickable`);
        if (state.name === 'tool-only') {
          assert.equal(await rows.locator('.wb-deco').count(), 0, `${locale}/${theme}/${width}: tool-only Changed row has no status letter`);
          assert.equal(await rows.first().getAttribute('data-change-status'), 'changed', `${locale}/${theme}/${width}: tool-only Changed row is unknown-status evidence`);
        }
        if (state.name === 'many') assert.ok(await rows.count() >= 10, `${locale}/${theme}/${width}: expanded Changed list shows ten or more files`);
        if (state.incomplete) assert.match(await changed.locator('summary').innerText(), /…/, `${locale}/${theme}/${width}: incomplete Changed warning is visible`);
        const bounds = await page.evaluate(({ replyId }) => {
          const reply = document.querySelector(`[data-message-id="${replyId}"]`);
          const timeline = [...document.querySelectorAll('.gc-timeline')].find(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height);
          const composer = document.querySelector('[data-testid=group-composer]');
          const rect = node => { const value=node.getBoundingClientRect(); return { top:value.top, bottom:value.bottom, left:value.left, right:value.right }; };
          return { timeline:timeline && rect(timeline), composer:composer && rect(composer), rows:[...(reply?.querySelectorAll('.gc-changed-list .wb-change-row') || [])].map(rect) };
        }, { replyId:sourceReply.id });
        const floor = Math.max(bounds.timeline?.top ?? 0, 0), ceiling = Math.min(bounds.timeline?.bottom ?? 1200, bounds.composer?.top ?? 1200, 1200);
        assert.ok(bounds.rows.every(row => row.top >= floor && row.bottom <= ceiling), `${state.name}/${locale}/${theme}/${width}: every expanded Changed row is inside the timeline clip and above the composer`);
        const titles = await rows.locator('.wb-change-open').evaluateAll(nodes => nodes.map(node => ({ title:node.getAttribute('title'), label:node.getAttribute('aria-label') })));
        if (state.name === 'tool-only') assert.equal(titles[0]?.title, locale === 'zh-CN' ? '由 Agent 的文件工具报告' : "Reported by the agent's file tool", `${locale}/${theme}/${width}: tool-only tooltip names its evidence`);
        if (state.incomplete) assert.equal(await changed.locator('summary').getAttribute('title'), locale === 'zh-CN' ? '可能缺少部分更改（文件夹过大，无法比较）' : 'Some changes may be missing (folder too large to compare)', `${locale}/${theme}/${width}: incomplete warning tooltip is retained`);
        metrics.push({ state:state.name, locale, theme, width, viewportHeight:1200, summaryTitle:await changed.locator('summary').getAttribute('title'), rowTitles:titles, bounds, ...(state.possible ? { possibleTitle:await reply().locator('.gc-possibly-changed > summary').getAttribute('title') } : {}) });
        await take(displayName(locale, theme, width, state.name));
      }
    }

    await clearState(page, groupId);
    await settle(page, app, 1280);
    await settings('en', 'light');
    await installState(page, groupId, source, outputFor(states[0]));
    await page.waitForTimeout(120);
    const changed = reply().locator('details').filter({ hasText:/Changed:/ }).first();
    await changed.waitFor();
    if (!(await changed.evaluate(node => node.open))) await changed.locator('summary').click();
    await changed.locator('summary').scrollIntoViewIfNeeded();
    assert.ok(await reply().locator('.gc-output-chips .chip').count() >= 2, 'output chips render with Changed rows');
    await take('group-changed-outputs-and-list-en-light-1280');
    check('Changed matrix: seven attribution states are expanded and visible in en/zh-CN, light/dark, 1280/900; output chips render with Changed rows');
    return { metrics };
  } finally {
    await clearState(page, groupId);
  }
}
