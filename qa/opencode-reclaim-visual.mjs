// Desktop-1, isolated production composer QA. No runtime or provider is started.
// The shared ChatView lease/Retry behavior is covered by opencode-reconnect-ordering.test.mjs.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const root = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), 'tt-opencode-reclaim-'));
const out = resolve('qa/results/browser-chat-followups/OC1/opencode-reclaim-visual');
const cells = ['light', 'dark', 'custom'].flatMap(theme => [398, 1144].flatMap(width =>
  ['provider-failed', 'lease-lost', 'lease-error'].map(state => ({ theme, width, state, passed: null, status: 'not-run', errors: [] }))));
const report = { passed: false, cells, errors: [] };
let app, page;
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerOptions } from './renderer/src/components/ComposerOptions';
import { Icon } from './renderer/src/components/PrototypeIcon';
import { applyThemeTokens } from './renderer/src/themes';
import { ChatConnectionChip } from './renderer/src/components/ChatConnectionChip';
import { ChatContextRing } from './renderer/src/components/ChatContextRing';
import './renderer/src/styles.css';
const copy = en => en;
const options = [
  { id:'next-model', name:'Model', category:'model', value:'model', choices:[{value:'model',name:'OpenAI · Long model name / slash'}] },
  { id:'agent', name:'Agent', category:'other', value:'build', choices:[{value:'build',name:'Build'},{value:'plan',name:'Plan'}] },
  { id:'variant', name:'Variant', category:'other', value:'precise', choices:[{value:'precise',name:'Precise'}] },
];
// Same palette as opencode-options-visual; production computes the state aliases.
const customTokens = { background:'#07111f', surface:'#10233c', text:'#ffffff', muted:'#91a4bf', accent:'#3b82f6', border:'#274768' };
const root = createRoot(document.getElementById('root'));
window.setCell = ({width,theme,lost,issue}) => {
  const base = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = base;
  applyThemeTokens(theme === 'custom' ? customTokens : undefined, base);
  document.documentElement.dataset.customTheme = String(theme === 'custom');
  root.render(<section className="v3-session-chat" style={{width,margin:24,height:600}}>
    <form className="chat-compose-shell" onSubmit={event => event.preventDefault()}>
      <textarea aria-label="Message" placeholder="Message" disabled />
      <ComposerOptions options={options} loadState="ready" zh={false} copy={copy} disabled busy={false} onSetOption={()=>{}}
        leading={<button type="button" className="icon-btn icon-btn-sm icon-btn-round chat-compose-icon" aria-label="Attach"><Icon name="plus" /></button>}
        status={<><ChatContextRing usage={{usedTokens:200,windowTokens:1000}} copy={copy}/><ChatConnectionChip phase="failed" providerName="OpenCode" onReconnect={()=>{}} copy={copy}/></>}
        trailing={<>{issue && <span className="dim">Could not take chat control. Retry from this view.</span>}{lost && <button type="button" className="chip chip-btn chat-compose-reclaim">Reclaim control</button>}<button type="button" className="icon-btn icon-btn-sm icon-btn-round is-primary chat-compose-send" aria-label="Send" disabled><Icon name="arrowUp" /></button></>}/>
    </form>
  </section>);
};
window.setCell({width:398,theme:'dark',lost:true,issue:true});
`;
try {
  await mkdir(out, { recursive: true });
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: root }, bundle: true, platform: 'browser', format: 'esm', outfile: join(scratch, 'fixture.js'), logLevel: 'error' });
  await writeFile(join(scratch, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(join(scratch,'profile'))}); app.whenReady().then(()=>{const win=new BrowserWindow({width:1440,height:900,webPreferences:{contextIsolation:true,sandbox:true}});win.loadFile(${JSON.stringify(join(scratch,'index.html'))});});`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|electron_run_as_node|threadterm_.*|tt_qa_.*)$/i.test(key)));
  env.Path = [dirname(process.execPath), join(process.env.SystemRoot || 'C:/Windows', 'System32')].join(';');
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], cwd: root, env, timeout: 60_000 });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.waitForFunction(() => typeof window.setCell === 'function');
  for (const cell of report.cells) {
    const { theme, width, state } = cell;
    const label = `${theme}/${width}/${state}`;
    try {
      // Reset a previous cell's popover/focus/hover before measuring this one.
      await page.keyboard.press('Escape');
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.activeElement?.blur());
      await page.evaluate(cell => window.setCell(cell), { width, theme, lost: state !== 'provider-failed', issue: state === 'lease-error' });
      await page.waitForFunction(width => Math.abs(document.querySelector('.v3-session-chat').getBoundingClientRect().width - width) < 1, width);
      // Allow React's existing composer measurement observer to settle; no product observer is added.
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const geometry = cell.geometry = await page.locator('.chat-compose-bar').evaluate(bar => {
        const box = node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
        const controls=[...bar.querySelectorAll('button')].filter(node=>node.getClientRects().length && !node.closest('.chat-compose-measure-clip'));
        const bounds=box(bar), rects=controls.map(node=>{ const style=getComputedStyle(node); return {label:node.getAttribute('aria-label')||node.textContent, ...box(node), borderWidth:style.borderTopWidth, borderStyle:style.borderTopStyle, borderColor:style.borderTopColor, disabled:node.disabled}; });
        const overlaps=[];
        for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++) { const a=rects[i],b=rects[j]; if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) overlaps.push([a.label,b.label]); }
        const style=getComputedStyle(document.documentElement);
        const tokens=Object.fromEntries(['background','surface','text','muted','accent','border'].map(key=>[key,style.getPropertyValue('--custom-'+key).trim()]));
        return {bounds,rects,overlaps,overflow:bar.scrollWidth>bar.clientWidth+1,tokens};
      });
      assert.deepEqual(geometry.overlaps, [], JSON.stringify(cell));
      assert.equal(geometry.overflow, false, JSON.stringify(cell));
      assert.ok(geometry.rects.every(rect => rect.left >= geometry.bounds.left-1 && rect.right <= geometry.bounds.right+1), JSON.stringify(cell));
      if (theme === 'custom') assert.ok(Object.values(geometry.tokens).every(Boolean), 'all six custom palette tokens are installed');
      // Match chat-visual-consistency: inspect the whole composer, including states.
      cell.consistency = await checkControlConsistency(page, '.chat-compose-shell', { checkStates: true, checkDisabledRows: true });
      assert.ok(cell.consistency.checked >= geometry.rects.length, 'every visible composer control is checked');
      assertNoControlViolations(cell.consistency, label);
      await page.getByRole('button', { name: /^Connection:/ }).click();
      await page.getByRole('dialog', { name: 'Connection details' }).waitFor();
      await page.keyboard.press('Escape');
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.activeElement?.blur());
      cell.passed = true; cell.status = 'passed';
    } catch (error) {
      cell.passed = false; cell.status = 'failed';
      const message = `${label}: ${error.stack ?? String(error)}`;
      cell.errors.push(message); report.errors.push(message);
    }
    // Keep a capture even for failed cells, then continue the remaining matrix.
    try {
      await page.screenshot({ path: join(out, `${theme}-${width}-${state}.png`) });
    } catch (error) {
      cell.passed = false; cell.status = 'failed';
      const message = `${label} screenshot: ${error.stack ?? String(error)}`;
      cell.errors.push(message); report.errors.push(message);
    }
    console.log(`${cell.status.toUpperCase()}: ${label}`);
  }
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => report.errors.push(String(error)));
  report.summary = { passed: report.cells.filter(cell => cell.passed === true).length, failed: report.cells.filter(cell => cell.passed === false).length, notRun: report.cells.filter(cell => cell.passed === null).length };
  report.passed = report.errors.length === 0 && report.summary.passed === report.cells.length;
  if (!report.passed) process.exitCode = 1;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)+'\n');
  console.log(`OPENCODE RECLAIM VISUAL ${report.passed ? 'PASSED' : 'FAILED'}: ${out}`);
}
