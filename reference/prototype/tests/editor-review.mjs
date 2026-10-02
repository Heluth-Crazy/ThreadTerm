import { startHarness, enter, act, assert, assertHealthy } from './harness.mjs';
import { expect } from '@playwright/test';

const harness = await startHarness();

async function scenario(name, callback) {
  await harness.scenario(name, async () => {
    const { page, context, errors, requests } = await harness.newPage();
    try {
      await enter(page, harness.origin);
      await callback(page);
      await assertHealthy(page, errors, requests);
    } finally {
      await context.close();
    }
  });
}

async function openOrbit(page, tab) {
  await act(page, 'open-session', { session: 'orbit-claude' });
  await act(page, 'ws-tab', { tab });
}

try {
  await scenario('editor retains redo after a shell rerender', async (page) => {
    await openOrbit(page, 'file');
    let content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// redo-survives-rerender');
    await page.keyboard.press('Control+s');
    await act(page, 'open-settings');
    await act(page, 'settings-open');
    await act(page, 'settings-section', { section: 'appearance' });
    await act(page, 'settings-theme', { theme: 'dark' });
    await act(page, 'settings-close');
    content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await content.click();
    await page.keyboard.press('Control+z');
    assert.equal((await content.innerText()).includes('redo-survives-rerender'), false);
    await page.keyboard.press('Control+Shift+z');
    assert.equal((await content.innerText()).includes('redo-survives-rerender'), true);
  });

  await scenario('diff reverts selected line and hunk, then makes staged content readonly', async (page) => {
    await openOrbit(page, 'diff');
    const current = page.locator('.tt-diff-host .cm-content[contenteditable="true"]');
    await current.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('// line-review-marker ');
    await act(page, 'editor-diff-revert-line');
    assert.equal((await current.innerText()).startsWith('// line-review-marker'), false);

    await current.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('// hunk-review-marker ');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.insertText('// hunk-review-marker-two ');
    await act(page, 'editor-diff-revert-hunk');
    assert.equal((await current.innerText()).includes('hunk-review-marker'), false);

    await current.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('// staged-review-marker ');
    await act(page, 'editor-diff-stage');
    assert.match(await page.locator('[data-testid="editor-diff-state"]').innerText(), /已暂存 · 两侧只读/);
    assert.equal(await page.locator('.tt-diff-host .cm-content[contenteditable="true"]').count(), 0);
    assert.equal(await page.locator('[data-action="editor-save"]').count(), 0);
  });

  await scenario('external conflict requires an explicit resolution before save', async (page) => {
    await act(page, 'open-scenarios');
    await act(page, 'editor-scenario', { scene: 'external' });
    await page.locator('[data-testid="editor-conflict"]').waitFor({ state: 'visible' });
    await act(page, 'editor-save');
    assert.equal(await page.locator('[data-testid="editor-conflict"]').count(), 1);
    await act(page, 'editor-conflict-reload');
    assert.equal(await page.locator('[data-testid="editor-conflict"]').count(), 0);
  });

  await scenario('search replace and document tabs retain separate drafts', async (page) => {
    await openOrbit(page, 'file');
    let content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await content.click();
    await page.keyboard.press('Control+f');
    await page.keyboard.press('Control+h');
    await page.locator('.cm-search input[name="search"]').fill('keepFocus');
    await page.locator('.cm-search input[name="replace"]').fill('keepFocusRenamed');
    await page.locator('.cm-search button[name="replaceAll"]').click();
    await page.locator('.cm-search button[name="close"]').click();
    await expect(content).toContainText('keepFocusRenamed');

    const tabs = page.locator('[data-testid="editor-file-tabs"] [data-editor-path]');
    const secondPath = await tabs.nth(1).getAttribute('data-editor-path');
    await tabs.nth(1).click();
    content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// second-document-draft');
    await tabs.nth(0).click();
    await page.locator(`[data-editor-path="${secondPath}"]`).click();
    await expect(page.locator('[data-testid="codemirror-editor"] .cm-content')).toContainText('second-document-draft');
  });

  await scenario('document tab close supports cancel save discard and reorder', async (page) => {
    await openOrbit(page, 'file');
    const tabs = page.locator('[data-testid="editor-file-tabs"] [data-editor-path]');
    const count = await tabs.count();
    const before = await tabs.allTextContents();
    await page.evaluate(() => {
      const [first, second] = document.querySelectorAll('[data-testid="editor-file-tabs"] [data-editor-path]');
      const transfer = new DataTransfer();
      first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      second.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      second.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      first.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    });
    assert.notDeepEqual(await page.locator('[data-testid="editor-file-tabs"] [data-editor-path]').allTextContents(), before);
    await page.reload();
    await act(page, 'ws-tab', { tab: 'file' });
    assert.notDeepEqual(await page.locator('[data-testid="editor-file-tabs"] [data-editor-path]').allTextContents(), before);

    const content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// close-current-draft');
    await act(page, 'editor-close');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(content).toContainText('close-current-draft');
    await act(page, 'editor-close');
    await act(page, 'editor-save-close');
    assert.equal(await page.locator('[data-testid="editor-file-tabs"] [data-editor-path]').count(), count - 1);
    await act(page, 'editor-close-all');
    await expect(page.locator('[data-testid="codemirror-editor"]')).toHaveCount(0);
  });

  await scenario('saved previews and unavailable file states are explicit', async (page) => {
    await openOrbit(page, 'file');
    await page.locator('[data-editor-path="preview/saved-demo.html"]').click();
    const htmlEditor = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await htmlEditor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('<p>unsaved preview marker</p>');
    await expect(page.locator('[data-testid="editor-dirty"]')).toBeVisible();
    await act(page, 'editor-preview');
    await expect(page.locator('.tt-preview-frame')).toHaveAttribute('sandbox', '');
    assert.equal((await page.locator('.tt-preview-frame').getAttribute('srcdoc')).includes('unsaved preview marker'), false);
    await act(page, 'editor-save');
    assert.equal((await page.locator('.tt-preview-frame').getAttribute('srcdoc')).includes('unsaved preview marker'), true);
    await page.locator('[data-editor-path="preview/developer-address.fixture.html"]').click();
    await act(page, 'editor-preview');
    await page.locator('#editor-address').fill('file:///private/file');
    await page.getByRole('button', { name: '确认预览', exact: true }).click();
    await expect(page.locator('[data-editor-address-error]')).toContainText('http');
    await page.locator('#editor-address').fill('http://localhost:4311/demo');
    await page.getByRole('button', { name: '确认预览', exact: true }).click();
    await expect(page.locator('.tt-preview-frame')).toHaveAttribute('sandbox', '');
    await expect(page.locator('.tt-preview-frame')).toHaveAttribute('srcdoc', /localhost:4311\/demo/);

    for (const [path, text] of [['preview/binary.fixture', '二进制文件'], ['preview/large.fixture', '文件过大']]) {
      await page.locator(`[data-editor-path="${path}"]`).click();
      await expect(page.getByText(text, { exact: false })).toBeVisible();
      assert.equal(await page.locator('.cm-content[contenteditable="true"]').count(), 0);
    }
    await page.locator('[data-editor-path="preview/unreadable.fixture"]').click();
    await expect(page.getByText('无法读取文件', { exact: false })).toBeVisible();
    await act(page, 'editor-retry-file');
    await expect(page.locator('.cm-content[contenteditable="true"]')).toBeVisible();
  });

  await scenario('file-tree-expands-and-close-others-keeps-current-draft', async (page) => {
    await openOrbit(page, 'file');
    await act(page, 'inspector-toggle');
    const tree = page.locator('[data-testid="editor-file-tree"]');
    await tree.locator('[data-editor-folder="tests"] > summary').click();
    await tree.locator('[data-editor-path="tests/payment.spec.ts"]').click();
    const content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// current tree-file draft');
    await act(page, 'editor-close-others');
    await expect(page.locator('[data-testid="editor-file-tabs"] [data-editor-path]')).toHaveCount(1);
    await expect(content).toContainText('current tree-file draft');
    await page.reload();
    await expect(content).toContainText('current tree-file draft');
  });

  await scenario('readonly-and-scenario-file-guards-survive-cached-editor-state', async (page) => {
    await openOrbit(page, 'file');
    const content = page.locator('[data-testid="codemirror-editor"] .cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n// cached draft before readonly');
    await act(page, 'open-scenarios');
    await act(page, 'editor-scenario', { scene: 'readonly' });
    await expect(content).toHaveAttribute('contenteditable', 'false');
    await expect(content).toContainText('cached draft before readonly');
    await act(page, 'open-scenarios');
    await act(page, 'editor-scenario', { scene: 'binary' });
    await expect(page.locator('[data-testid="codemirror-editor"]')).toHaveAttribute('data-editor-state', 'binary');
    await act(page, 'open-scenarios');
    await act(page, 'editor-scenario', { scene: '' });
    await expect(content).toHaveAttribute('contenteditable', 'true');
    await expect(content).toContainText('cached draft before readonly');
  });
} finally {
  await harness.finish('editor-review-results.json');
}
