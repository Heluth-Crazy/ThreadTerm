import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'results', 'parity-workspace-actions', new Date().toISOString().replace(/[:.]/g, '-'));
const report = { startedAt: new Date().toISOString(), checks: [], errors: [] };
const apps = [];
const note = (name, detail = {}) => report.checks.push({ name, ...detail });

async function open(profile) {
  const app = await electron.launch({ args: [join(here, 'parity/electron-static.cjs')], env: { ...process.env, TT_PARITY_PROFILE: profile }, timeout: 20_000 });
  apps.push(app);
  const page = await app.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(12_000);
  return { app, page };
}

// This wraps the QA-only memory bridge: the renderer gets protocol-shaped
// responses and every intercepted call is retained as test evidence.
function extensions() {
  const prior = window.threadterm.request.bind(window.threadterm);
  const calls = window.__parityFixture.calls;
  let workspaceRevision = 0, fileRevision = 0, draftRevision = 0;
  const drafts = new Map();
  window.threadterm.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'session.create') return { id: 'qa-created', ...params, status: 'starting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (method === 'workspace.save') return { id: params.id ?? 'qa-workspace', name: params.name, projectId: params.projectId, worktreePath: params.worktreePath, layout: params.layout, revision: ++workspaceRevision };
    if (method === 'filesystem.write') return { path: params.path, content: params.content, fingerprint: `qa-write-${++fileRevision}`, readonly: false, size: params.content.length, modifiedAt: new Date().toISOString() };
    if (method === 'draft.put') {
      const value = { id: drafts.get(params.path)?.id ?? `qa-draft-${++draftRevision}`, path: params.path, content: params.content, baseFingerprint: params.baseFingerprint, revision: (drafts.get(params.path)?.revision ?? 0) + 1 };
      drafts.set(params.path, value);
      return value;
    }
    if (method === 'draft.delete') {
      for (const [path, value] of drafts) if (value.id === params.id) drafts.delete(path);
      return null;
    }
    return prior(method, params);
  };
  window.__workspaceCalls = calls;
}

async function closeAll() { for (const app of apps.splice(0)) await app.close().catch(() => {}); }
async function reset(page, url) {
  await page.goto(url);
  await page.locator('.proj-row').first().waitFor();
  await page.locator('.sess-row').first().click();
  await page.locator('.session-screen.runtime-workspace').waitFor();
}
// Files and diffs open from the workbench side bar (the inspector file list and the in-tab
// "Files & Git" panel were replaced by it).
async function sideView(page, name) {
  const button = page.locator('.wb-switcher').getByRole('button', { name });
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
}
async function revealFileTree(page) {
  await sideView(page, /^(files|文件)$/i);
  await page.locator('.wb-tree [role="treeitem"]').first().waitFor();
  for (let step = 0; step < 40; step += 1) {
    const closed = page.locator('.wb-tree [role="treeitem"][aria-expanded="false"]');
    if (!await closed.count()) return;
    await closed.first().click();
    await page.waitForTimeout(30);
  }
}
const fileRows = (page, name) => page.locator('.wb-tree [role="treeitem"]:not([aria-expanded])').filter({ has: page.locator('.wb-name', { hasText: name }) });
async function openFileWorkspace(page) {
  await revealFileTree(page);
  await fileRows(page, /\.(?:tsx?|jsx?|json|rs|txt)$/i).first().click();
  await page.locator('.tt-editor-shell .cm-content:visible').waitFor();
}
async function workspaceAction(page,name){await page.getByRole('button',{name:/workspace actions|工作区操作/i}).click();await page.getByRole('button',{name}).click();await page.keyboard.press('Escape');}
async function openDiff(page){await sideView(page,/^(source control|源代码管理)$/i);await page.locator('.wb-changes .wb-change-open').first().click();await page.locator('.tt-diff-shell:visible').waitFor();}
async function editCurrentFile(page, marker) {
  const editor = page.locator('.tt-editor-shell .cm-content:visible');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(marker);
  await page.locator('.file-workspace.embedded:visible .file-view-tabs button:not([disabled])').filter({hasText:/^(save file|保存文件)$/i}).waitFor();
  assert.ok((await editor.innerText()).includes(marker.trim()), 'visible editor retains the unsaved marker');
}
async function dirtyExit(page, choice) {
  await page.locator('.ws-back').click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: ({ cancel: /cancel|取消/i, discard: /discard|放弃/i, save: /^(save file|保存文件)$/i })[choice] }).click();
}
async function runCase(name, page, url, action) {
  try {
    await reset(page, url);
    await action();
    note(name, { passed: true });
  } catch (error) {
    await page.screenshot({ path: join(out, `${name}-failure.png`) }).catch(() => {});
    note(name, { passed: false, error: error instanceof Error ? error.stack : String(error) });
  }
}

async function run() {
  await mkdir(out, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'tt-ws-actions-'));
  let referenceServer, productionServer, page;
  const deadline = setTimeout(() => { report.errors.push('Hard 150s deadline exceeded'); void closeAll(); }, 150_000);
  try {
    referenceServer = await startReadonlyReferenceServer(join(root, 'reference'));
    const reference = await open(join(scratch, 'reference'));
    await reference.page.goto(referenceServer.origin + '/prototype/');
    await reference.page.waitForFunction(() => !!window.ThreadTermPrototype);
    const seed = await reference.page.evaluate(() => {
      const app = window.ThreadTermPrototype;
      return { projects: app.projects, trees: app.trees, sessions: app.sessions(), store: app.store, fileContents: Object.fromEntries(Object.entries(app.projects).map(([id, project]) => [id, Object.fromEntries(project.files.map((path, index) => [path, app.fileValue(app.sessions().find(item => item.project === id), index)]))])) };
    });
    seed.sessions.push({ ...seed.sessions[0], id: 'qa-same-tree-second', name: 'QA same worktree peer', time: '今天 14:20' });
    // Preview variants are explicit fixture documents, so this exercise does
    // not rely on a root-level source file coincidentally having either type.
    const previewProject = seed.sessions[0].project;
    seed.projects[previewProject].files.push('preview/qa-preview.md', 'preview/qa-preview.html');
    seed.fileContents[previewProject]['preview/qa-preview.md'] = '# QA Markdown preview\n\nLocal preview content.';
    seed.fileContents[previewProject]['preview/qa-preview.html'] = '<main><h1>QA HTML preview</h1></main>';
    await reference.app.close();

    const production = await open(join(scratch, 'production'));
    page = production.page;
    await page.addInitScript(installVisualFixture, { seed, theme: 'light' });
    await page.addInitScript(extensions);
    productionServer = await startReadonlyReferenceServer(join(root, 'desktop-dist/renderer'));
    const url = productionServer.origin + '/?theme=light';

    await runCase('workspace-split-save-and-exit', page, url, async () => {
      await workspaceAction(page,/split right|左右拆分/i);
      await page.getByRole('button',{name:/^choose session$|^选择会话$/i}).click();
      const peer = page.locator('.switcher-row').first();
      await peer.click();
      await page.waitForFunction(() => window.__workspaceCalls.some(call => call.method === 'workspace.save' && call.params.layout.kind === 'split'));
      assert.equal(await page.locator('.pane-workspace .workspace-pane').count(), 2);
      await workspaceAction(page,/^close pane$|^关闭窗格$/i);
      await page.waitForFunction(() => window.__workspaceCalls.filter(call => call.method === 'workspace.save').some(call => call.params.layout.kind === 'pane'));
      assert.equal(await page.locator('.pane-workspace').count(), 1);
    });

    for (const choice of ['cancel', 'discard', 'save']) await runCase(`dirty-navigation-${choice}`, page, url, async () => {
      await openFileWorkspace(page);
      await editCurrentFile(page, ` QA-${choice}`);
      await dirtyExit(page, choice);
      if (choice === 'cancel') {
        await page.locator('.session-screen.runtime-workspace').waitFor();
        assert.equal(await page.getByRole('button',{name:/^(save file|保存文件)$/i}).isEnabled(),true);
        assert.ok((await page.locator('.tt-editor-shell .cm-content:visible').innerText()).includes('QA-cancel'));
      } else {
        // Back leaves a session for its branch home page (user decision 2026-09-28), not All terminals.
        await page.locator('[data-testid="project-home"]').waitFor();
        if (choice === 'save') await page.waitForFunction(() => window.__workspaceCalls.some(call => call.method === 'filesystem.write' && call.params.content.includes('QA-save')));
      }
    });

    await runCase('markdown-and-html-preview-exit', page, url, async () => {
      await openFileWorkspace(page);
      await revealFileTree(page);
      const markdown = fileRows(page, /\.mdx?$/i), html = fileRows(page, /\.html?$/i);
      assert.ok(await markdown.count(), 'fixture must expose a Markdown file');
      assert.ok(await html.count(), 'fixture must expose an HTML file');
      await markdown.first().click();
      if(!await page.locator('.file-preview .markdown-preview:visible').count())await page.getByRole('button',{name:/^(preview|预览)$/i}).click();
      await page.locator('.file-preview .markdown-preview:visible').waitFor();
      await html.first().click();
      await page.getByRole('button',{name:/^(preview|预览)$/i}).click();
      await page.locator('iframe[title="Saved HTML preview"]').waitFor();
      await openDiff(page);
    });

    await runCase('diff-line-hunk-undo-and-save', page, url, async () => {
      await openFileWorkspace(page);await openDiff(page);
      const current = page.locator('.tt-diff-shell .tt-diff-host .cm-content').last();
      await current.waitFor();
      await current.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' QA-DIFF-UNDO');
      await page.keyboard.press('Control+z');
      assert.doesNotMatch(await current.innerText(), /QA-DIFF-UNDO/);
      await page.keyboard.type(' QA-DIFF-SAVE');
      await page.getByRole('button', { name: /revert current line|还原当前行/i }).click();
      await page.getByRole('button', { name: /revert current hunk|还原当前块/i }).click();
      await current.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' QA-DIFF-FINAL');
      const save = page.getByRole('button', { name: /save changes|保存变更/i });
      await save.waitFor();
      await save.click();
      await page.waitForFunction(() => window.__workspaceCalls.some(call => call.method === 'filesystem.write' && call.params.content.includes('QA-DIFF-FINAL')));
      const write = await page.evaluate(() => window.__workspaceCalls.filter(call => call.method === 'filesystem.write').at(-1));
      assert.equal(write.params.path.length > 0, true);
      assert.equal(write.params.content.includes('QA-DIFF-FINAL'), true);
    });
  } catch (error) {
    report.errors.push(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await closeAll();
    await productionServer?.close().catch(() => {});
    await referenceServer?.close().catch(() => {});
    report.completedAt = new Date().toISOString();
    if(report.errors.length||report.checks.some(check=>check.passed===false))process.exitCode=1;
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, report }, null, 2));
  }
}
await run();







