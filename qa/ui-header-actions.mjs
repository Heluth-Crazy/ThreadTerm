// Desktop-1 QA for the production workspace and project header controls.
// The app uses a read-only prototype seed and a protocol-shaped renderer fixture;
// no provider, native runtime, user profile, database, or user desktop is used.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/desktop1.mjs';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';
import { installVisualFixture } from './parity/fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) ?? 'after';
const values = (key, fallback) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3).split(',') ?? fallback;
const sizes = values('sizes', ['1280x800', '1440x900', '1920x1080', '960x800', '720x800']).map(value => value.split('x').map(Number));
const themes = values('themes', ['light', 'dark']);
const langs = values('langs', ['en', 'zh']);
const neutralPalette = process.argv.includes('--neutral-palette');
const cropsOnly = process.argv.includes('--crops-only');
const out = resolve(values('out', [join(here, 'results', 'ui-header-actions', phase)])[0]);
const scratch = await mkdtemp(join(tmpdir(), `tt-header-${phase}-`));
const isolatedHome = join(scratch, 'home');
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
Object.assign(childEnv, {
  Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'),
  HOME: isolatedHome, USERPROFILE: isolatedHome, HOMEDRIVE: isolatedHome.slice(0, 2), HOMEPATH: isolatedHome.slice(2),
  CODEX_HOME: join(isolatedHome, '.codex'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
  THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'userdata'),
  THREADTERM_V3_PIPE: `\\\\.\\pipe\\threadterm-header-${randomUUID()}`,
  TT_QA_DESKTOP: '1', TT_PARITY_PROFILE: join(scratch, 'electron-profile'),
});
const report = { phase, startedAt: new Date().toISOString(), shots: [], cases: [], errors: [] };
const apps = [];
let referenceServer, productionServer;

function note(name, detail = {}) { report.cases.push({ name, ...detail }); }
async function open(profile) {
  const env = { ...childEnv, TT_PARITY_PROFILE: profile };
  const app = await electron.launch({ args: [join(here, 'parity/electron-static.cjs')], env, timeout: 25_000 });
  apps.push(app);
  const page = await app.firstWindow({ timeout: 20_000 });
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => report.errors.push(error.message));
  return { app, page };
}
async function seedFixture() {
  const ref = await open(join(scratch, 'reference-profile'));
  await ref.page.goto(referenceServer.origin + '/prototype/');
  await ref.page.waitForFunction(() => !!window.ThreadTermPrototype);
  const seed = await ref.page.evaluate(() => {
    const api = window.ThreadTermPrototype;
    return { projects: api.projects, trees: api.trees, sessions: api.sessions(), store: api.store,
      fileContents: Object.fromEntries(Object.entries(api.projects).map(([id, project]) => [id,
        Object.fromEntries(project.files.map((path, index) => [path, api.fileValue(api.sessions().find(item => item.project === id), index)]))])) };
  });
  const longProjectSession = seed.sessions.find(item => item.name === '清理前的完成记录');
  if (longProjectSession) {
    seed.projects[longProjectSession.project].name = 'Project name used to verify that long header labels stay bounded';
    if (seed.trees[longProjectSession.tree]) seed.trees[longProjectSession.tree].missing = true;
  }
  await ref.app.close();
  apps.splice(apps.indexOf(ref.app), 1);
  return seed;
}

async function configure(page, app, width, height, theme, lang, origin) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  await page.goto(`${origin}/?theme=${theme}&lang=${lang}`);
  await page.locator('.sess-row').first().waitFor();
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
  await page.addStyleTag({ content: '.titlebar.app-chrome{display:none!important}.app-shell{grid-template-rows:minmax(0,1fr) 24px!important}.app-shell>.sidebar,.app-shell>.content.main{grid-row:1!important}.app-shell>.statusbar{grid-row:2!important}*,*::before,*::after{animation:none!important;transition:none!important}' });
  const { settings } = await page.evaluate(() => window.threadterm.request('runtime.snapshot', {}));
  await page.evaluate(([language, revision, id]) => window.threadterm.request('settings.update', { patch: { language }, expectedRevision: revision, operationId: id }), [lang === 'zh' ? 'zh-CN' : 'en', settings.revision, randomUUID()]);
  await page.waitForTimeout(80);
}
async function openSession(page) {
  await page.locator('.sess-row').filter({ hasText: '清理前的完成记录' }).first().click();
  await page.locator('.session-screen.runtime-workspace').waitFor();
}
async function openProject(page) {
  const projectRow = page.locator('.proj-row').first();
  if (await projectRow.isVisible()) await projectRow.click();
  else await page.locator('.ws-top .ws-chip').first().click();
  await page.locator('.ov-page-head').waitFor();
}
async function metrics(page, selectors) {
  return page.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const label = element.querySelector('.ws-chip-label');
    return { selector, text: element.innerText.trim().replace(/\\s+/g, ' ').slice(0, 80), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      radius: style.borderRadius, padding: style.padding, fontSize: style.fontSize, background: style.backgroundColor, borderColor: style.borderColor,
      classes: element.className, title: element.title || undefined,
      label: label ? { text: label.innerText, clientWidth: label.clientWidth, scrollWidth: label.scrollWidth, textOverflow: getComputedStyle(label).textOverflow } : undefined };
  })), selectors);
}
async function cancelDialog(page, opener, openAction, buttonLabel) {
  await opener.click();
  const dialog = page.locator('[role="dialog"]:visible').last();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: buttonLabel }).click();
  await dialog.waitFor({ state: 'hidden' });
  await openAction.waitFor();
  return dialog;
}
async function assertNeutralPalette(page, tag) {
  const colors = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const token = name => root.getPropertyValue(name).trim();
    const rgba = value => {
      const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
      if (hex) {
        const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map(char => char + char).join('') : hex;
        if (expanded.length !== 6 && expanded.length !== 8) throw new Error(`Cannot parse color: ${value}`);
        const channels = expanded.match(/../g).map(channel => parseInt(channel, 16));
        return [channels[0], channels[1], channels[2], channels[3] === undefined ? 1 : channels[3] / 255];
      }
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      if (channels.length < 3) throw new Error(`Cannot parse computed color: ${value}`);
      if (value.startsWith('color(srgb ')) return [channels[0] * 255, channels[1] * 255, channels[2] * 255, channels[3] ?? 1];
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    };
    const composite = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [0, 1, 2].map(index => (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha).concat(alpha);
    };
    const colorString = color => `rgb(${color.slice(0, 3).map(value => Math.round(value)).join(', ')})`;
    const luminance = color => color.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (foreground, background) => {
      const a = luminance(foreground), b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const pageBackground = element => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (color[3] >= 0.999) return { color, source: node.className?.toString() || node.tagName.toLowerCase() };
      }
      return { color: rgba(token('--bg')), source: '--bg fallback' };
    };
    const primary = document.querySelector('.ov-page-head .page-actions .btn-primary');
    const secondary = document.querySelector('.ov-page-head .page-actions .btn:not(.btn-primary):not(.ql-trigger)');
    if (!primary || !secondary) throw new Error('Project header primary or secondary action is missing');
    const primaryStyle = getComputedStyle(primary), secondaryStyle = getComputedStyle(secondary);
    const background = pageBackground(secondary);
    const actualPrimaryBg = rgba(primaryStyle.backgroundColor), actualPrimaryFg = rgba(primaryStyle.color);
    const actualSecondaryBg = rgba(secondaryStyle.backgroundColor), actualSecondaryBorder = rgba(secondaryStyle.borderTopColor), actualSecondaryFg = rgba(secondaryStyle.color);
    const runStyle = getComputedStyle(document.querySelector('.ov-page-head .page-actions .ql-trigger'));
    const runFg = rgba(runStyle.color);
    const text = rgba(token('--text')), surface = rgba(token('--surface')), muted = rgba(token('--muted'));
    return {
      tokens: { text: colorString(text), surface: colorString(surface), muted: colorString(muted), focus: colorString(rgba(token('--primary'))), bg: token('--bg'), soft: token('--soft') },
      primary: { background: colorString(actualPrimaryBg), foreground: colorString(actualPrimaryFg), backgroundTokenMatch: colorString(actualPrimaryBg) === colorString(text), foregroundTokenMatch: colorString(actualPrimaryFg) === colorString(surface), contrast: contrast(actualPrimaryFg, actualPrimaryBg) },
      secondary: { background: colorString(actualSecondaryBg), border: secondaryStyle.borderTopColor, foreground: colorString(actualSecondaryFg), transparentFill: actualSecondaryBg[3] === 0, transparentBorder: actualSecondaryBorder[3] === 0, mutedTokenMatch: colorString(actualSecondaryFg) === colorString(muted), contrast: contrast(composite(actualSecondaryFg, background.color), background.color), pageBackground: colorString(background.color), pageBackgroundSource: background.source },
      run: { foreground: colorString(runFg), mutedTokenMatch: colorString(runFg) === colorString(muted), contrast: contrast(composite(runFg, background.color), background.color) },
    };
  });
  assert.equal(colors.primary.backgroundTokenMatch, true, `${tag}: primary background follows --text`);
  assert.equal(colors.primary.foregroundTokenMatch, true, `${tag}: primary foreground follows --surface`);
  assert.ok(colors.primary.contrast >= 4.5, `${tag}: primary contrast ${colors.primary.contrast.toFixed(2)}:1 below 4.5:1`);
  assert.equal(colors.secondary.transparentFill, true, `${tag}: secondary fill is transparent`);
  assert.equal(colors.secondary.transparentBorder, true, `${tag}: secondary border is transparent`);
  assert.equal(colors.secondary.mutedTokenMatch, true, `${tag}: secondary text follows --muted`);
  assert.ok(colors.secondary.contrast >= 4.5, `${tag}: secondary contrast ${colors.secondary.contrast.toFixed(2)}:1 below 4.5:1 on ${colors.secondary.pageBackgroundSource}`);
  assert.equal(colors.run.mutedTokenMatch, true, `${tag}: Run action text follows --muted`);
  assert.ok(colors.run.contrast >= 4.5, `${tag}: Run contrast ${colors.run.contrast.toFixed(2)}:1 below 4.5:1`);

  const secondary = page.locator('.ov-page-head .page-actions .btn').filter({ hasText: /new worktree|新建工作树/i });
  await secondary.hover();
  const secondaryHover = await secondary.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
  const expectedSoft = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const value = root.getPropertyValue('--soft').trim();
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  });
  assert.equal(secondaryHover.background, expectedSoft, `${tag}: secondary hover uses --soft`);

  const primary = page.locator('.ov-page-head .page-actions .btn-primary');
  await primary.hover();
  const primaryHover = await primary.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }));
  const expectedPrimaryHover = await primary.evaluate(element => {
    const parse = value => {
      const hex = value.match(/^#([\da-f]{6})$/i)?.[1];
      if (hex) return hex.match(/../g).map(channel => parseInt(channel, 16));
      const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number);
      return value.startsWith('color(srgb ') ? channels.map(channel => channel * 255) : channels;
    };
    const root = getComputedStyle(document.documentElement);
    const foreground = parse(root.getPropertyValue('--text'));
    const background = parse(root.getPropertyValue('--bg'));
    const expected = foreground.map((value, index) => value * .88 + background[index] * .12);
    const actual = parse(getComputedStyle(element).backgroundColor);
    return expected.every((value, index) => Math.abs(value - actual[index]) <= 1);
  });
  assert.equal(expectedPrimaryHover, true, `${tag}: primary hover uses the neutral --text mix (computed ${primaryHover.background})`);
  assert.equal(primaryHover.color, colors.tokens.surface, `${tag}: primary hover keeps surface foreground`);

  const run = page.locator('.ov-page-head .page-actions .ql-trigger');
  await run.focus();
  await page.keyboard.press('Tab');
  const primaryFocus = await primary.evaluate(element => ({ active: element === document.activeElement, visible: element.matches(':focus-visible'), outlineColor: getComputedStyle(element).outlineColor, outlineWidth: getComputedStyle(element).outlineWidth }));
  await page.keyboard.press('Tab');
  const secondaryFocus = await secondary.evaluate(element => ({ active: element === document.activeElement, visible: element.matches(':focus-visible'), outlineColor: getComputedStyle(element).outlineColor, outlineWidth: getComputedStyle(element).outlineWidth }));
  for (const [name, focus] of [['primary', primaryFocus], ['secondary', secondaryFocus]]) {
    assert.ok(focus.active && focus.visible && parseFloat(focus.outlineWidth) >= 1, `${tag}: ${name} action retains keyboard focus indication`);
    assert.equal(focus.outlineColor, colors.tokens.focus, `${tag}: ${name} focus outline follows --primary`);
  }

  await openSession(page);
  await page.locator('.ws-top .ws-chip.branch').click();
  const disabled = page.locator('.ov-page-head .page-actions .btn-primary');
  assert.equal(await disabled.isDisabled(), true, `${tag}: New terminal remains disabled for missing worktree`);
  const disabledStyle = await disabled.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, foreground: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity, cursor: getComputedStyle(element).cursor }));
  assert.ok(Number(disabledStyle.opacity) < 1 && disabledStyle.cursor === 'default', `${tag}: disabled primary remains visibly disabled`);
  const createsBefore = await page.evaluate(() => window.__parityFixture.calls.filter(call => call.method === 'session.create').length);
  await disabled.evaluate(element => element.click());
  const createsAfter = await page.evaluate(() => window.__parityFixture.calls.filter(call => call.method === 'session.create').length);
  assert.equal(createsAfter, createsBefore, `${tag}: disabled New terminal issues no create request`);
  return { ...colors, secondaryHover, primaryHover, primaryFocus, secondaryFocus, disabled: disabledStyle };
}

try {
  await mkdir(out, { recursive: true });
  referenceServer = await startReadonlyReferenceServer(join(root, 'reference'));
  productionServer = await startReadonlyReferenceServer(join(root, 'desktop-dist', 'renderer'));
  const seed = await seedFixture();
  const production = await open(join(scratch, 'production-profile'));
  const { app, page } = production;
  await page.addInitScript(installVisualFixture, { seed, theme: 'light' });

  for (const [width, height] of sizes) for (const theme of themes) for (const lang of langs) {
    const tag = `${width}x${height}-${theme}-${lang}`;
    await configure(page, app, width, height, theme, lang, productionServer.origin);
    await page.evaluate(() => {
      const prior = window.threadterm.request.bind(window.threadterm);
      window.threadterm.request = (method, params) => {
        if (method === 'quickLaunch.list' || method === 'quickLaunch.setup.status') {
          window.__parityFixture.calls.push({ method, params });
          return Promise.resolve([]);
        }
        return prior(method, params);
      };
    });
    await openSession(page);
    const sessionGeometry = await metrics(page, ['.ws-top .ws-back', '.ws-top .runtime-nav-toggle', '.ws-top .ws-chip', '.ws-top .ql-trigger', '.ws-top > .icon-btn']);
    const headerBounds = await page.locator('.ws-top').evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, right: rect.right, width: rect.width }; });
    await page.screenshot({ path: join(out, `session-${tag}.png`), animations: 'disabled' });
    report.shots.push(`session-${tag}.png`);
    const projectChip = page.locator('.ws-top .ws-chip').first();
    await projectChip.click();
    await page.locator('.ov-page-head').waitFor();
    if (cropsOnly) {
      await page.locator('.ov-page-head .page-actions .btn-primary:not(:disabled)').waitFor();
      await page.mouse.move(0, 0);
      const filename = `actions-${theme}-zh.png`;
      await page.locator('.ov-page-head .page-actions').screenshot({ path: join(out, filename), animations: 'disabled' });
      report.shots.push(filename);
      note(`crop-${tag}`, { passed: true });
      continue;
    }
    const projectGeometry = await metrics(page, ['.ov-page-head .page-actions > .ql-trigger', '.ov-page-head .page-actions > .btn', '.ov-page-head .project-tools > .icon-btn']);
    const actionSemantics = await page.locator('.ov-page-head .page-actions > .btn').evaluateAll(elements => elements.map(element => ({ text: element.textContent.trim(), primary: element.classList.contains('btn-primary') })));
    await page.screenshot({ path: join(out, `project-${tag}.png`), animations: 'disabled' });
    report.shots.push(`project-${tag}.png`);

    const geometry = { session: sessionGeometry, project: projectGeometry, actionSemantics, headerBounds };
    note(`geometry-${tag}`, { passed: true, geometry });
    if (phase === 'after') {
      for (const item of [...sessionGeometry.filter(item => item.selector.includes('.ws-chip') || item.selector.includes('.ql-trigger')),
        ...projectGeometry]) {
        assert.ok(Math.abs(item.height - 32) <= 1, `${tag}: ${item.selector} ${item.text} height ${item.height}, expected 32`);
        assert.equal(item.radius, item.selector.includes('.ov-page-head') ? '6px' : '8px', `${tag}: ${item.selector} ${item.text} radius ${item.radius}`);
      }
      const title = await page.locator('.ov-title-row .page-title').evaluate(element => ({ width: element.clientWidth, contentWidth: element.scrollWidth, text: element.textContent }));
      assert.ok(title.width >= Math.min(title.contentWidth, 240), tag + ': header keeps useful title identity before actions (' + JSON.stringify(title) + ')');
      const primary = actionSemantics.filter(item => item.primary);
      assert.equal(primary.length, 1, `${tag}: exactly New terminal is primary`);
      assert.match(primary[0].text, /new terminal|新建终端/i, `${tag}: primary action label`);
      assert.ok(projectGeometry.every(item => item.x >= 0 && item.x + item.width <= width + 1), `${tag}: project header action overflows viewport`);
      const overflowing = sessionGeometry.filter(item => item.width > 0 || item.height > 0)
        .filter(item => item.x < headerBounds.x - 1 || item.x + item.width > headerBounds.right + 1);
      assert.equal(overflowing.length, 0, `${tag}: long session header labels overflow the header (${JSON.stringify({ headerBounds, overflowing })})`);
      const projectLabel = sessionGeometry.find(item => item.selector.includes('.ws-chip') && item.text.includes('Project name used'));
      assert.ok(projectLabel && projectLabel.title?.includes('Project name used'), `${tag}: long project label remains available in its tooltip`);
      if (projectLabel.label.scrollWidth > projectLabel.label.clientWidth) assert.equal(projectLabel.label.textOverflow, 'ellipsis', `${tag}: clipped project label uses ellipsis`);
    }
    if (neutralPalette && phase === 'after') {
      const palette = await assertNeutralPalette(page, tag);
      note(`neutral-palette-${tag}`, { passed: true, palette });
    }
    if (width === 1280 && lang === 'zh' && (theme === 'light' || theme === 'dark')) {
      await openProject(page);
      await page.locator('.ov-page-head .page-actions .btn-primary:not(:disabled)').waitFor();
      await page.mouse.move(0, 0);
      const filename = `actions-${theme}-zh.png`;
      await page.locator('.ov-page-head .page-actions').screenshot({ path: join(out, filename), animations: 'disabled' });
      report.shots.push(filename);
    }

    // Project and branch chips retain their navigation meaning.
    await openSession(page);
    await page.locator('.ws-top .ws-chip.branch').click();
    await page.locator('.ov-page-head').waitFor();
    note(`branch-navigation-${tag}`, { passed: true, heading: await page.locator('.ov-title-row .page-title').innerText() });
    assert.equal(await page.locator('.ov-page-head .page-actions .btn-primary').isDisabled(), true, `${tag}: New terminal stays disabled for the missing worktree`);
    assert.equal(await page.locator('.ov-page-head .page-actions .btn').filter({ hasText: /new worktree|新建工作树/i }).isDisabled(), false, `${tag}: New worktree remains available for the missing worktree`);
    note(`missing-worktree-action-${tag}`, { passed: true });

    // Run popover closes on Escape and restores focus to its trigger.
    await openSession(page);
    const trigger = page.locator('.ws-top .ql-trigger');
    await trigger.click();
    await page.locator('.ql-menu:visible').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.ql-menu:visible').waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true, `${tag}: Run trigger regains focus`);
    note(`run-escape-focus-${tag}`, { passed: true });

    if (width === 1280 && theme === 'dark' && lang === 'en') {
      const keyboardFocus = async (start, target, label) => {
        const startControl = page.locator(start).first(), targetControl = page.locator(target).first();
        await startControl.focus();
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await page.keyboard.press('Tab');
          if (await targetControl.evaluate(element => element === document.activeElement)) break;
        }
        const state = await targetControl.evaluate(element => {
          const style = getComputedStyle(element);
          return { active: element === document.activeElement, focusVisible: element.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
        });
        assert.ok(state.active && state.focusVisible && state.outlineStyle !== 'none' && parseFloat(state.outlineWidth) >= 1, `${tag}: ${label} has keyboard-visible focus (${JSON.stringify(state)})`);
      };
      await openSession(page);
      await keyboardFocus('.ws-top .ws-back', '.ws-top .ws-chip', 'project chip');
      await keyboardFocus('.ws-top .ws-chip', '.ws-top .ql-trigger', 'Run control');
      await page.locator('.ws-top .ws-chip').first().click();
      await page.locator('.ov-page-head').waitFor();
      await keyboardFocus('.ov-page-head .page-actions .ql-trigger', '.ov-page-head .page-actions .btn-primary', 'New terminal action');
      await keyboardFocus('.ov-page-head .page-actions .btn-primary', '.ov-page-head .page-actions > .btn:not(.btn-primary):not(.ql-trigger)', 'New worktree action');
      note(`header-keyboard-focus-${tag}`, { passed: true });
    }

    // Creation dialogs cancel without calling create actions or changing route.
    await openProject(page);
    const creationsBefore = await page.evaluate(() => window.__parityFixture.calls.filter(call => ['session.create', 'worktree.create'].includes(call.method)).length);
    const newTerminal = page.locator('.ov-page-head .page-actions .btn-primary');
    await newTerminal.click();
    const creationDialog = page.locator('[role="dialog"]:visible').last();
    await creationDialog.waitFor();
    if (width === 1280 && theme === 'dark' && lang === 'en') {
      const lastControl = creationDialog.locator('.dlg-foot button').last();
      await lastControl.focus();
      await page.keyboard.press('Tab');
      assert.equal(await creationDialog.evaluate(element => element.contains(document.activeElement)), true, `${tag}: New terminal dialog traps Tab`);
      const combo = creationDialog.locator('.tt-select-trigger').first();
      await combo.focus();
      await page.keyboard.press('Enter');
      await page.locator('.tt-select-menu:visible').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.tt-select-menu:visible').waitFor({ state: 'hidden' });
      assert.equal(await creationDialog.isVisible(), true, `${tag}: first Escape closes the open select only`);
      await page.keyboard.press('Escape');
      await creationDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.ov-page').count(), 1, `${tag}: second Escape closes New terminal without navigating`);
      note(`new-terminal-modal-keyboard-${tag}`, { passed: true });
      await newTerminal.click();
      await creationDialog.waitFor();
    }
    await creationDialog.getByRole('button', { name: /cancel|取消/i }).click();
    await creationDialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ov-page').count(), 1, `${tag}: terminal dialog cancellation stays on project page`);
    const treeAction = page.locator('.ov-page-head .page-actions .btn').filter({ hasText: /new worktree|新建工作树/i });
    await treeAction.click();
    const treeDialog = page.locator('[role="dialog"]:visible').last();
    await treeDialog.waitFor();
    if (width === 1280 && theme === 'dark' && lang === 'en') {
      const lastControl = treeDialog.locator('.dlg-foot button').last();
      await lastControl.focus();
      await page.keyboard.press('Tab');
      assert.equal(await treeDialog.evaluate(element => element.contains(document.activeElement)), true, `${tag}: New worktree dialog traps Tab`);
      await page.keyboard.press('Escape');
      await treeDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.ov-page').count(), 1, `${tag}: New worktree Escape cancellation preserves project navigation`);
      note(`new-worktree-modal-keyboard-${tag}`, { passed: true });
      await treeAction.click();
      await treeDialog.waitFor();
    }
    await treeDialog.getByRole('button', { name: /cancel|取消/i }).click();
    await treeDialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ov-page').count(), 1, `${tag}: worktree dialog cancellation stays on project page`);
    const creationsAfter = await page.evaluate(() => window.__parityFixture.calls.filter(call => ['session.create', 'worktree.create'].includes(call.method)).length);
    assert.equal(creationsAfter, creationsBefore, `${tag}: canceled creation dialogs issue no create requests`);
    note(`create-dialog-cancel-${tag}`, { passed: true });
  }
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  for (const app of apps.splice(0)) await app.close().catch(() => {});
  await productionServer?.close().catch(() => {});
  await referenceServer?.close().catch(() => {});
  report.completedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, phase, shots: report.shots.length, cases: report.cases.length, errors: report.errors }, null, 2));
}
