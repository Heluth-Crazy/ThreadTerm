// Isolated regression QA for the production modal focus hook and Select.
// Desktop1 mounts only fixture dialogs; no runtime, provider, or user profile.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { electron } from './lib/desktop1.mjs';
import { startReadonlyReferenceServer } from './parity/reference-server.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'tt-modal-focus-'));
const fixture = join(scratch, 'fixture'), renderer = join(scratch, 'renderer');
const isolatedHome = join(scratch, 'home'), isolatedCodexHome = join(isolatedHome, '.codex'), profile = join(scratch, 'profile');
const isolatedAppData = join(scratch, 'appdata'), isolatedLocalAppData = join(scratch, 'localappdata');
const isolatedData = join(scratch, 'data'), isolatedUserData = join(scratch, 'user-data');
const isolatedPipe = `\\\\.\\pipe\\tt-modal-focus-${randomUUID()}`;
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg >= 0 ? process.argv[outArg + 1] : join(root, 'qa', 'results', 'ui-modal-focus'));
const report = { passed: false, checks: [], errors: [] };
let server, app;
const check = label => { report.checks.push(label); console.log(`PASS ${label}`); };
try {
  await Promise.all([fixture, renderer, profile, isolatedHome, isolatedCodexHome, isolatedAppData, isolatedLocalAppData, isolatedData, isolatedUserData, out].map(path => mkdir(path, { recursive: true })));
  const imports = [
    `import React from 'react';`,
    `import { createRoot } from 'react-dom/client';`,
    `import { SurfaceDialog } from '${join(root, 'renderer/src/components/SurfaceDialog.tsx').replaceAll('\\', '/')}';`,
    `import { Select } from '${join(root, 'renderer/src/components/ui/Select.tsx').replaceAll('\\', '/')}';`,
    `import { I18nProvider } from '${join(root, 'renderer/src/i18n.tsx').replaceAll('\\', '/')}';`,
    `import { CommandPalette } from '${join(root, 'renderer/src/components/CommandPalette.tsx').replaceAll('\\', '/')}';`,
    `import '${join(root, 'renderer/src/styles.css').replaceAll('\\', '/')}';`,
  ].join('\n');
  await writeFile(join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(fixture, 'entry.tsx'), `${imports}
    const paletteData={epoch:'1',revision:0,projects:[],sessions:[],workspaces:[],inbox:[],providers:[],settings:{}};
    function Fixture(){
      const [parent,setParent]=React.useState(false),[child,setChild]=React.useState(false),[value,setValue]=React.useState('codex');
      const [palette,setPalette]=React.useState(false),[runs,setRuns]=React.useState([]);
      const ran=name=>setRuns(list=>[...list,name]);
      window.__modalQA={openParent:()=>setParent(true), parentOpen:()=>parent, childOpen:()=>child, openPalette:()=>setPalette(true), paletteOpen:()=>palette, paletteRuns:()=>runs.slice()};
      return <I18nProvider locale="en"><main><button onClick={()=>setParent(true)}>Open parent</button>
        <button onClick={()=>setPalette(true)}>Open palette</button>
        {palette&&<CommandPalette data={paletteData} onClose={()=>setPalette(false)} onSession={id=>ran('session:'+id)} onProject={id=>ran('project:'+id)} onCreate={()=>ran('new')} onCreateGroup={()=>ran('new-group')} onAll={()=>ran('all')} onInbox={()=>ran('inbox')} onSettings={()=>ran('settings')}/>}
        {parent&&<SurfaceDialog title="Parent dialog" onClose={()=>setParent(false)}>
          <button onClick={()=>setChild(true)}>Open child</button>
          <Select aria-label="Provider" value={value} onChange={event=>setValue(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option></Select>
          <button>Parent last action</button>
          <details><summary>Pricing</summary><button>Save prices</button></details>
        </SurfaceDialog>}
        {child&&<SurfaceDialog title="Child dialog" onClose={()=>setChild(false)}><button>Child action</button></SurfaceDialog>}
      </main></I18nProvider>
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `);
  await viteBuild({ root: fixture, configFile: false, plugins: [react()], resolve: { alias: [
    { find: /^react$/, replacement: join(root, 'node_modules/react/index.js') },
    { find: /^react-dom\/client$/, replacement: join(root, 'node_modules/react-dom/client.js') },
    { find: /^react\/jsx-runtime$/, replacement: join(root, 'node_modules/react/jsx-runtime.js') },
    { find: '@threadterm/protocol', replacement: join(root, 'protocol/index.ts') },
  ] }, build: { outDir: renderer, emptyOutDir: true, rollupOptions: { input: join(fixture, 'index.html') } } });
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|homedrive|homepath|codex_home|appdata|localappdata|threadterm_v3_.*|tt_qa_.*|tt_parity_profile|electron_run_as_node)$/i.test(key)));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  Object.assign(childEnv, { Path: [dirname(process.execPath), join(systemRoot, 'System32')].join(';'), HOME: isolatedHome, USERPROFILE: isolatedHome, HOMEDRIVE: isolatedHome.slice(0, 2), HOMEPATH: isolatedHome.slice(2), CODEX_HOME: isolatedCodexHome, APPDATA: isolatedAppData, LOCALAPPDATA: isolatedLocalAppData, THREADTERM_V3_DATA: isolatedData, THREADTERM_V3_USER_DATA: isolatedUserData, THREADTERM_V3_PIPE: isolatedPipe, TT_QA_DESKTOP: '1', TT_PARITY_PROFILE: profile });
  server = await startReadonlyReferenceServer(renderer);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', join(root, 'qa/parity/electron-static.cjs')], env: childEnv, timeout: 30000 });
  const page = await app.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.goto(`${server.origin}/`);
  const opener = page.getByRole('button', { name: 'Open parent' });
  await opener.click();
  const parent = page.getByRole('dialog', { name: 'Parent dialog' }); await parent.waitFor();
  const select = parent.getByRole('combobox', { name: 'Provider' });
  await select.focus(); await page.keyboard.press('Enter');
  assert.equal(await select.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await select.getAttribute('aria-expanded'), 'false', 'first Escape dismisses the expanded select');
  assert.equal(await parent.isVisible(), true, 'first Escape leaves the owning modal open');
  assert.equal(await select.evaluate(node => document.activeElement === node), true, 'select retains focus after dismissing its listbox');
  await page.keyboard.press('Escape');
  await parent.waitFor({ state: 'hidden' });
  assert.equal(await opener.evaluate(node => document.activeElement === node), true, 'modal dismissal restores focus to its opener');
  check('expanded combobox consumes first Escape; second Escape closes modal and restores focus');

  await opener.click();
  const parent2 = page.getByRole('dialog', { name: 'Parent dialog' }); await parent2.waitFor();
  await parent2.getByRole('button', { name: 'Open child' }).click();
  const child = page.getByRole('dialog', { name: 'Child dialog' }); await child.waitFor();
  const childAction = child.getByRole('button', { name: 'Child action' });
  await childAction.focus(); await page.keyboard.press('Tab');
  assert.equal(await child.getByRole('button', { name: 'Close Child dialog' }).evaluate(node => document.activeElement === node), true, 'Tab from last child action wraps to first child control');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await childAction.evaluate(node => document.activeElement === node), true, 'Shift+Tab wraps to last child control');
  await page.keyboard.press('Escape');
  await child.waitFor({ state: 'hidden' });
  assert.equal(await parent2.isVisible(), true, 'Escape closes only the topmost nested modal');
  assert.equal(await parent2.getByRole('button', { name: 'Open child' }).evaluate(node => document.activeElement === node), true, 'nested dismissal restores focus to its opener');
  await page.keyboard.press('Escape');
  await parent2.waitFor({ state: 'hidden' });
  assert.equal(await opener.evaluate(node => document.activeElement === node), true, 'outer dismissal restores focus to its opener');
  check('topmost nested modal traps Tab, closes independently, and restores focus at both levels');

  await opener.click();
  const parent3 = page.getByRole('dialog', { name: 'Parent dialog' }); await parent3.waitFor();
  const summary = parent3.getByText('Pricing', { exact: true });
  const visibility = await page.evaluate(() => {
    const summary = document.querySelector('details > summary'), save = document.querySelector('details button');
    return { summaryVisible: summary.checkVisibility(), summaryRects: summary.getClientRects().length, saveVisible: save.checkVisibility(), saveRects: save.getClientRects().length };
  });
  assert.equal(visibility.summaryVisible, true); assert.ok(visibility.summaryRects > 0);
  assert.equal(visibility.saveVisible, false, 'closed details action is not visibly rendered');
  report.closedDetailsVisibility = visibility;
  await parent3.getByRole('button', { name: 'Parent last action' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await summary.evaluate(node => document.activeElement === node), true, 'native summary remains keyboard-tabbable');
  await page.keyboard.press('Tab');
  const tabOutcome = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim(), label: document.activeElement?.getAttribute('aria-label') }));
  assert.equal(await parent3.getByRole('button', { name: 'Close Parent dialog' }).evaluate(node => document.activeElement === node), true, `Tab from the final visible summary wraps to the first modal control, skipping closed details content; active=${JSON.stringify(tabOutcome)}`);
  check(`focus trap follows visible native tab stops (closed Save prices rects=${visibility.saveRects}, checkVisibility=${visibility.saveVisible})`);
  await page.keyboard.press('Escape');
  await parent3.waitFor({ state: 'hidden' });

  // The command palette is a modal too: it must trap Tab, restore focus and leave IME keys to the candidate window.
  const paletteOpener = page.getByRole('button', { name: 'Open palette' });
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const paletteInput = palette.locator('.palette-input');
  const runs = () => page.evaluate(() => window.__modalQA.paletteRuns());
  const activeRow = () => page.evaluate(() => document.querySelector('.palette .cmd-row.active')?.textContent ?? '');
  const dispatchKey = (key, options = {}) => page.evaluate(({ key, isComposing, keyCode }) => {
    const target = document.activeElement;
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing });
    if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { key, isComposing: options.isComposing === true, keyCode: options.keyCode });
  await paletteOpener.click();
  await palette.waitFor();
  assert.equal(await paletteInput.evaluate(node => document.activeElement === node), true, 'palette moves focus into its input when it opens');
  await page.screenshot({ path: join(out, 'palette-en.png') });
  report.screenshots = ['palette-en.png'];
  const settledRow = await activeRow();
  const composing = {};
  for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
    composing[key] = await dispatchKey(key, { isComposing: true });
    assert.deepEqual(await runs(), [], `${key} while an IME candidate window is open runs no command`);
    assert.equal(await palette.isVisible(), true, `${key} while composing leaves the palette open`);
    assert.equal(await activeRow(), settledRow, `${key} while composing does not move the selection`);
  }
  composing.keyCode229 = await dispatchKey('Enter', { keyCode: 229 });
  assert.deepEqual(await runs(), [], 'Enter with the IME key code runs no command');
  assert.equal(await palette.isVisible(), true, 'Enter with the IME key code leaves the palette open');
  assert.equal(composing.keyCode229, true, 'the IME key code Enter is swallowed instead of reaching the input');
  report.composingKeystrokes = composing;
  await page.keyboard.press('Shift+Tab');
  assert.equal(await palette.locator('.cmd-row').last().evaluate(node => document.activeElement === node), true, 'Shift+Tab from the palette input wraps to the last command row');
  await page.keyboard.press('Tab');
  assert.equal(await paletteInput.evaluate(node => document.activeElement === node), true, 'Tab from the last command row wraps back to the input');
  await page.keyboard.press('Enter');
  await palette.waitFor({ state: 'hidden' });
  assert.deepEqual(await runs(), ['new'], 'a settled Enter runs exactly the active command once');
  assert.equal(await paletteOpener.evaluate(node => document.activeElement === node), true, 'palette dismissal restores focus to its opener');
  check('palette traps Tab, restores focus, ignores composing Enter/Escape/arrows and keyCode 229, and runs one command on a settled Enter');

  await paletteOpener.click();
  await palette.waitFor();
  await dispatchKey('Escape', { isComposing: true });
  assert.equal(await palette.isVisible(), true, 'a composing Escape leaves the palette open');
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
  assert.equal(await paletteOpener.evaluate(node => document.activeElement === node), true, 'Escape closes the palette and restores focus to its opener');
  check('palette closes on a settled Escape only, then returns focus');
  assert.deepEqual(report.errors, [], 'fixture has no page errors');
  report.passed = true;
} catch (error) {
  report.errors.push(error?.stack ?? String(error));
  console.error(report.errors.at(-1));
  process.exitCode = 1;
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\r\n');
  await app?.close().catch(() => {});
  await server?.close().catch(() => {});
  const resolvedScratch = resolve(scratch), resolvedTemp = resolve(tmpdir());
  if (dirname(resolvedScratch).toLowerCase() === resolvedTemp.toLowerCase() && basename(resolvedScratch).startsWith('tt-modal-focus-')) {
    await rm(resolvedScratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
}
assert.equal(report.errors.length, 0, report.errors.join('\n'));
