import assert from 'node:assert/strict';

const name = (en, zh) => new RegExp(`^(?:${en}|${zh})$`);

export async function captureGroupComposerMatrix({ page, app, request, groupId, memberSessionId, take, back, check, settings }) {
  const group = () => page.locator(`[data-testid="group-view"][data-group-id="${groupId}"]:visible`);
  const composer = () => group().getByTestId('group-composer');
  const input = () => composer().getByTestId('group-message');
  const attach = () => composer().getByRole('button', { name: name('Attach reference', '附加引用') });
  const include = () => composer().getByRole('button', { name: name('Include', '包含') });
  const dismiss = () => composer().getByRole('button', { name: name('Dismiss', '关闭') });
  const alert = () => composer().getByRole('alert');
  const attachment = () => composer().getByRole('textbox', { name: name('File path or URL', '文件路径或网址') });
  const stateName = (locale, theme, width, state) => `group-composer-${locale}-${theme}-${width}-${state}`;
  const settle = async width => {
    await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 900), width);
    await page.waitForFunction(value => innerWidth === value, width);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const clearReferences = async () => {
    const remove = composer().getByRole('button', { name: /^(?:Remove reference|移除引用)/ });
    while (await remove.count()) await remove.first().click();
  };
  const validReference = async () => {
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/uri-list', 'http://127.0.0.1/group-composer-reference');
      document.querySelector('[data-testid=group-composer]').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await composer().getByTestId('group-includes').waitFor();
  };
  const invalidDrop = async () => {
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'javascript:invalid');
      document.querySelector('[data-testid=group-composer]').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await alert().waitFor();
  };
  const geometry = async (scope, surface) => scope.evaluate((root, surface) => {
    const box = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
    const pick = selector => root.matches(selector) ? root : root.querySelector(selector);
    const shell = pick('.chat-compose-shell'), textarea = pick('textarea'), bar = pick('.chat-compose-bar'), left = pick('.chat-compose-left'), right = pick('.chat-compose-right');
    const padding = getComputedStyle(textarea);
    const rows = [[...root.querySelectorAll('.gc-composer-chips')], textarea, bar, pick('[role=alert]')].flat().filter(Boolean).map(box);
    return { surface, shell:box(shell), textarea:box(textarea), textareaTextLeft:textarea.getBoundingClientRect().left + parseFloat(padding.paddingLeft), bar:box(bar), left:left&&box(left), right:right&&box(right), rows, verticalGaps:rows.slice(1).map((row, index) => row.top - rows[index].bottom) };
  }, surface);
  const metrics = [];
  const handle = (await request('group.read', { id: groupId })).members[0].handle;
  for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1280, 900]) {
    await settle(width);
    await settings(locale, theme);
    await input().fill('');
    await clearReferences();
    await take(stateName(locale, theme, width, 'idle'));

    await input().fill(`@${handle} composer recipients`);
    await take(stateName(locale, theme, width, 'recipients'));
    const recipientChipHeight = await composer().locator('.gc-recipient').first().evaluate(node => node.getBoundingClientRect().height);

    await validReference();
    await take(stateName(locale, theme, width, 'references'));
    const referenceChipHeight = await composer().locator('.gc-reference').first().evaluate(node => node.getBoundingClientRect().height);
    await clearReferences();
    await input().fill('');

    await attach().click();
    await attachment().fill('../outside');
    await include().click();
    await alert().waitFor();
    const warningText = await alert().innerText();
    assert.match(warningText, locale === 'zh-CN' ? /请选择群聊目录内的路径/ : /Choose a path inside the group folder/, `${locale}/${theme}/${width}: attach warning uses current locale`);
    await take(stateName(locale, theme, width, 'warning'));
    if (locale === 'en' && theme === 'light' && width === 1280) {
      await settings('zh-CN', theme);
      assert.match(await alert().innerText(), /请选择群聊目录内的路径/, 'stored attach warning rerenders after English to Chinese language switch');
      await settings(locale, theme);
      assert.match(await alert().innerText(), /Choose a path inside the group folder/, 'stored attach warning rerenders after Chinese to English language switch');
    }
    await dismiss().click();
    await alert().waitFor({ state: 'detached' });
    await attachment().fill('../outside');
    await include().click();
    await alert().waitFor();
    await attachment().fill('edited');
    await alert().waitFor({ state: 'detached' });
    await attachment().press('Escape');
    await attachment().waitFor({ state: 'detached' });

    await attach().click();
    await take(stateName(locale, theme, width, 'attach'));
    await attachment().press('Escape');

    await invalidDrop();
    assert.match(await alert().innerText(), locale === 'zh-CN' ? /请拖入群聊目录中的文件路径/ : /Drop a file path inside this group folder/, `${locale}/${theme}/${width}: drop warning uses current locale`);
    await take(stateName(locale, theme, width, 'drop-warning'));
    await page.evaluate(() => document.querySelector('[data-testid=group-composer]').dispatchEvent(new DragEvent('drop', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true })));
    await alert().waitFor({ state: 'detached' });
    await invalidDrop();
    await input().fill('edit clears drop warning');
    await alert().waitFor({ state: 'detached' });

    await attach().click();
    await attachment().fill('../outside');
    await include().click();
    await alert().waitFor();
    await input().fill(`@${handle} successful send clears warning`);
    await composer().getByTestId('group-send').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=group-message]')?.value === '');
    await alert().waitFor({ state: 'detached' });
    await attach().click();
    await attachment().waitFor({ state: 'detached' });

    const groupMetrics = await geometry(composer(), `group/${locale}/${theme}/${width}`);
    assert.ok(groupMetrics.rows.every(row => Math.abs(row.left - groupMetrics.textareaTextLeft) <= 1), `${locale}/${theme}/${width}: Group composer rows share textarea text edge`);
    metrics.push(groupMetrics);

    await request('session.present', { sessionId: memberSessionId, placement:'workspace', presentation:'focused', operationId:crypto.randomUUID() });
    const chat = page.getByTestId(`session-chat-${memberSessionId}`);
    await chat.waitFor();
    const chatChip = chat.locator('.chat-compose-shell .chip').first();
    const chatChipSource = await chatChip.count() ? 'chip' : 'toolbar-control';
    const chatChipHeight = await (await chatChip.count() ? chatChip : chat.locator('.chat-compose-bar button').first()).evaluate(node => node.getBoundingClientRect().height);
    assert.ok(Math.abs(recipientChipHeight-chatChipHeight)<=0.5, `${locale}/${theme}/${width}: recipient chip matches Chat ${chatChipSource} height`);
    assert.ok(Math.abs(referenceChipHeight-chatChipHeight)<=0.5, `${locale}/${theme}/${width}: reference chip matches Chat ${chatChipSource} height`);
    const chatMetrics = await geometry(chat, `chat/${locale}/${theme}/${width}`);
    chatMetrics.chipHeight = chatChipHeight;
    chatMetrics.chipSource = chatChipSource;
    groupMetrics.recipientChipHeight = recipientChipHeight;
    groupMetrics.referenceChipHeight = referenceChipHeight;
    metrics.push(chatMetrics);
    await take(`chat-composer-${locale}-${theme}-${width}`);
    await back();
  }
  check('composer matrix: en/zh-CN, light/dark, 1280/900 captures idle, recipients, references, warnings and attach rows; attach/drop warnings dismiss and auto-clear');
  return { metrics };
}

export async function captureGroupSurfaces({ page, app, groupId, take, check, settings }) {
  const group = () => page.locator(`[data-testid="group-view"][data-group-id="${groupId}"]:visible`);
  const cancel = async () => page.getByRole('button', { name: /^(?:Cancel|取消)$/ }).click();
  for (const locale of ['en', 'zh-CN']) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
    await page.waitForFunction(() => innerWidth === 1280);
    await settings(locale, 'light');
    await group().getByRole('button', { name: /^(?:Add agent|添加智能体)$/ }).click();
    await page.getByRole('dialog').waitFor();
    await take(`group-add-agent-${locale}-light-1280`);
    await cancel();

    await group().getByRole('button', { name: /^(?:More @|更多 @)/ }).first().click();
    await page.getByRole('dialog').waitFor();
    await take(`group-member-editor-${locale}-light-1280`);
    await cancel();

    await page.locator('.nav-item.new').click();
    const dialog = page.getByTestId('session-create-dialog');
    await dialog.getByTestId('session-kind-group').click();
    await take(`group-create-${locale}-light-1280`);
    await cancel();
  }
  check('Group add-agent, member-editor and create dialogs render in English and Chinese');
}
