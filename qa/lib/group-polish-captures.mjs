/**
 * Extra visual evidence for Group polish. The read override is renderer-only:
 * it never writes the live Group or creates synthetic Chat sessions.
 */
export async function captureGroupPolish({ page, app, request, groupId, take, check, until }) {
  const view = () => page.locator(`[data-testid="group-view"][data-group-id="${groupId}"]:visible`);
  const actual = await request('group.read', { id: groupId });
  if (!actual.members.length) throw Error('Group polish capture requires one real member.');
  const settleSize = async width => {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 900), width);
    await page.waitForFunction(value => innerWidth === value, width);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const refreshVisualMembers = async count => {
    await page.evaluate(({ id, count }) => {
      globalThis.__GC_QA_STATE__ = result => {
        if (result.id !== id || !result.members.length) return result;
        const group = structuredClone(result), source = group.members[0];
        const states = ['working', 'queued', 'needs_user', 'failed', 'idle', 'idle'];
        group.members = Array.from({ length: count }, (_, index) => ({
          ...source,
          sessionId: `${source.sessionId}-visual-${count}-${index + 1}`,
          handle: `polish-${index + 1}`,
          state: states[index] ?? 'idle',
          ...(states[index] === 'failed' ? { error: 'Visual-only fixture failure' } : {}),
        }));
        return group;
      };
    }, { id: groupId, count });
    await page.evaluate(id => globalThis.__GC_QA_REFRESH__(id), groupId);
    await until(() => view().count().then(Boolean), `visual ${count}-member Group reload`);
    await until(() => view().locator('.gc-member').count().then(value => value === count), `visual ${count}-member strip`);
  };
  const captureMembers = async count => {
    await refreshVisualMembers(count);
    for (const width of [1280, 900]) {
      await settleSize(width);
      await take(`group-members-${count}-${width}`);
    }
  };

  await captureMembers(1);
  await captureMembers(6);
  await page.evaluate(() => { delete globalThis.__GC_QA_STATE__; });
  await page.evaluate(id => globalThis.__GC_QA_REFRESH__(id), groupId);
  await until(() => view().count().then(Boolean), 'restore real Group after visual member captures');
  await settleSize(1280);

  await page.locator('.nav-item.new').click();
  const dialog = page.getByTestId('session-create-dialog');
  await dialog.waitFor();
  await dialog.getByTestId('session-kind-group').click();
  await until(() => dialog.getByTestId('group-add-member').isEnabled(), 'group member controls');
  while (await dialog.locator('[data-testid^="group-member-"]').count() < 3) {
    await dialog.getByTestId('group-add-member').click();
  }
  for (let index = 0; index < 3; index++) {
    await dialog.getByTestId(`group-member-${index}`).locator('.group-handle input').fill('duplicate');
  }
  await until(() => dialog.locator('.group-member-note').count().then(value => value >= 2), 'duplicate handle errors');
  await until(async () => !/Unavailable|不可用/.test(await dialog.getByTestId('group-member-0').getByRole('combobox').first().innerText()), 'selected provider prerequisites settled');
  await dialog.getByTestId('group-add-member').scrollIntoViewIfNeeded();
  await take('group-create-three-members-duplicate-handle');
  await page.getByRole('dialog').getByRole('button', { name: /^(Cancel|取消)$/ }).click();
  check('captured visual-only one/six member strips at 1280/900 and cancelled a three-member duplicate-handle dialog');
}
