// Consume actual adapter projections from the fixture regression's --nocapture log.
// Example: node qa/opencode-partial-model-visual.mjs D:/tt-issue76-green.log
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { electron } from './lib/desktop1.mjs';
import { oc2VisualEntry } from './oc2-opencode-visual-fixture.mjs';

const log = await readFile(process.argv[2], 'utf8');
const snapshots = log.split(/\r?\n/).flatMap(line => {
  const index = line.indexOf('partial-model-ui:');
  return index < 0 ? [] : [JSON.parse(line.slice(index + 'partial-model-ui:'.length))];
});
assert.deepEqual(snapshots.map(row => row.case), ['partial', 'empty', 'live-empty', 'live-complete', 'complete', 'complete']);
const initial = snapshots[0].ui;
const selected = initial.options.find(row => row.id === 'next-model');
const choice = selected.choices.find(row => row.value === selected.value);
assert.ok(choice);
let entry = oc2VisualEntry();
const start = entry.indexOf('const ui=');
const end = entry.indexOf('\nconst emit=', start);
assert.ok(start >= 0 && end > start, 'known visual bridge fixture');
entry = entry.slice(0, start) + `const ui=${JSON.stringify(initial)};` + entry.slice(end);
entry += '\nwindow.qaCatalogue=(state)=>{Object.assign(ui,state);emit("chat.ui",{...state,sessionId});};';
const scratch = await mkdtemp(resolve('.compat', 'partial-model-visual-'));
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true,
  outfile: join(scratch, 'qa.js'), jsx: 'automatic',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);
const app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.qaRender === 'function');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.qaRender({ theme, width: 1280 }), theme);
    for (const [index, snapshot] of snapshots.entries()) {
      await page.evaluate(state => window.qaCatalogue(state), snapshot.ui);
      const chip = page.locator('.chat-model-chip');
      await chip.filter({ hasText: choice.name }).waitFor();
      await chip.click();
      const menu = page.getByRole('menu', { name: 'Model and thinking level', exact: true });
      await menu.waitFor();
      const item = menu.getByRole('menuitemradio', { name: choice.name, exact: true });
      assert.equal(await item.count(), 1, 'selected model appears once');
      assert.equal(await item.getAttribute('aria-checked'), 'true');
      await page.screenshot({ path: join(scratch, `${theme}-${index}-${snapshot.case}.png`) });
      await page.keyboard.press('Escape');
    }
  }
  console.log(`PASS partial/empty/complete model projections in production ChatView: ${scratch}`);
} finally {
  await app.close();
}
