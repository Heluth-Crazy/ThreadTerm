// Isolated Electron regression QA for nested workspace splitter geometry.
// It mounts the production PaneWorkspace and CSS with inert, missing-session tabs;
// no provider, terminal, runtime, or user profile is started.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-pane-resize-'));
const out = resolve('qa/results/pane-resize');
await mkdir(out, { recursive: true });

const entry = `
import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PaneWorkspace} from './renderer/src/components/PaneWorkspace';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const pane = id => ({kind:'pane',id,tabs:[{id:'tab-'+id,kind:'session',sessionId:'missing-'+id}],activeTabId:'tab-'+id});
const layouts = {
  two: {kind:'split',id:'root-two',direction:'horizontal',ratio:.5,first:pane('left'),second:pane('right')},
  three: {kind:'split',id:'root-three',direction:'horizontal',ratio:.5,first:{kind:'split',id:'left-three',direction:'horizontal',ratio:.5,first:pane('left-a'),second:pane('left-b')},second:pane('right')},
  four: {kind:'split',id:'root-four',direction:'horizontal',ratio:.58,first:{kind:'split',id:'left-four',direction:'horizontal',ratio:.42,first:pane('left-a'),second:pane('left-b')},second:{kind:'split',id:'right-four',direction:'horizontal',ratio:.61,first:pane('right-a'),second:pane('right-b')}},
  mixed: {kind:'split',id:'root-mixed',direction:'horizontal',ratio:.56,first:{kind:'split',id:'left-mixed',direction:'vertical',ratio:.46,first:pane('top-left'),second:pane('bottom-left')},second:{kind:'split',id:'right-mixed',direction:'vertical',ratio:.64,first:pane('top-right'),second:pane('bottom-right')}},
};
function Fixture(){
  const [layout,setLayout] = useState(layouts.two);
  useEffect(() => { window.qaLayout=layout; }, [layout]);
  window.qaRender = name => setLayout(structuredClone(layouts[name]));
  return React.createElement(I18nProvider,{locale:'en'},React.createElement(PaneWorkspace,{layout,sessions:[],theme:document.documentElement.dataset.theme==='dark'?'dark':'light',terminalCompatibility:{},onChange:setLayout}));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic' });
await writeFile(join(scratch, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>
html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}#root{display:flex;min-width:0;min-height:0}
.pane-workspace{width:100%;height:100%;display:flex;min-width:0;min-height:0}.workspace-pane{display:flex;flex-direction:column;min-width:0;min-height:0}
.ws-tile-bar{display:flex;flex:0 0 32px;min-width:0}.pane-body{display:flex;flex:1;min-width:0;min-height:0}.pane-divider{background:color-mix(in srgb,#579 18%,transparent)}
html[data-theme="dark"]{background:#12161d;color:#ecf2f8}html[data-theme="light"]{background:#fff;color:#20242a}
</style><div id="root"></div><script src="qa.js"></script>`);
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);

const near = (actual, expected, message, tolerance = 2) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ±${tolerance}, got ${actual}`);
let app;
const report = { startedAt: new Date().toISOString(), passed: false, checks: [], screenshots: [], geometry: {} };
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.qaRender && window.qaLayout);
  const layout = async () => page.evaluate(() => window.qaLayout);
  const ratios = async () => page.evaluate(() => {
    const result = {};
    const visit = node => { if (node.kind === 'split') { result[node.id] = node.ratio; visit(node.first); visit(node.second); } };
    visit(window.qaLayout); return result;
  });
  const box = async (selector) => page.locator(selector).evaluate(el => { const r=el.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; });
  const dividerTarget = splitId => `[data-split-id="${splitId}"] > .pane-divider`;
  const assertDivider = async splitId => {
    const expectedRatio=(await ratios())[splitId];
    const actual = await page.locator(dividerTarget(splitId)).evaluate(divider => {
      const split=divider.parentElement, r=split.getBoundingClientRect(), d=divider.getBoundingClientRect(), s=getComputedStyle(split);
      const gap=Number.parseFloat(s.gap) || 0, vertical=split.classList.contains('vertical');
      const total=(vertical?r.height:r.width)- (vertical?d.height:d.width) - gap*2;
      return {vertical,center:vertical?d.top+d.height/2:d.left+d.width/2,edge:(vertical?r.top:r.left),total,gap,dividerSize:vertical?d.height:d.width};
    });
    near(actual.center, actual.edge+expectedRatio*actual.total+actual.gap+actual.dividerSize/2, `divider ${splitId} tracks its persisted ratio`);
  };
  const drag = async (splitId, fraction) => {
    const target=page.locator(dividerTarget(splitId)); await target.waitFor();
    const r=await box(dividerTarget(splitId));
    const vertical=await target.evaluate(el => el.parentElement.classList.contains('vertical'));
    const parent=await box(`[data-split-id="${splitId}"]`);
    const ratiosBefore=await ratios();
    const start={x:r.left+r.width/2,y:r.top+r.height/2};
    const end=vertical?{x:start.x,y:parent.top+parent.height*fraction}:{x:parent.left+parent.width*fraction,y:start.y};
    await page.mouse.move(start.x,start.y); await page.mouse.down(); await page.waitForTimeout(10);
    const afterDown=await box(dividerTarget(splitId));
    near(vertical ? afterDown.top+afterDown.height/2 : afterDown.left+afterDown.width/2, vertical ? start.y : start.x, `pointer-down on ${splitId} does not move its divider`);
    assert.deepEqual(await ratios(),ratiosBefore,`pointer-down on ${splitId} does not change a ratio`);
    await page.mouse.move(end.x,end.y,{steps:8}); await page.mouse.up();
    await page.waitForTimeout(35);
    const resultRatio=(await ratios())[splitId], after=await box(dividerTarget(splitId));
    if (resultRatio > .1 && resultRatio < .9) near(vertical ? after.top+after.height/2 : after.left+after.width/2, vertical ? end.y : end.x, `interior drag ${splitId} keeps divider under pointer`);
  };
  const assertOnlyRatio = async (before, id) => {
    const after=await ratios();
    for (const [key,value] of Object.entries(before)) assert.equal(after[key] !== value, key === id, `only ${id} changes its persisted ratio`);
  };
  const assertFullyAllocated = async (label) => {
    const allocation=await page.evaluate(() => [...document.querySelectorAll('[data-split-id]')].map(split => {
      const r=split.getBoundingClientRect(), vertical=split.classList.contains('vertical'), children=[...split.children];
      const start=Math.min(...children.map(child => vertical ? child.getBoundingClientRect().top : child.getBoundingClientRect().left));
      const end=Math.max(...children.map(child => vertical ? child.getBoundingClientRect().bottom : child.getBoundingClientRect().right));
      return {id:split.dataset.splitId,allocated:end-start,extent:vertical?r.height:r.width};
    }));
    for (const item of allocation) near(item.allocated,item.extent,`${label}: split ${item.id} fully allocates its axis`,3);
  };

  // Reproduce the user path: split the left pane of a two-pane workspace.
  await page.evaluate(() => window.qaRender('two'));
  await page.waitForFunction(() => window.qaLayout.id === 'root-two');
  const originalRight=await box('[data-pane-id="right"]');
  await page.locator('[data-pane-id="left"] button[aria-label="Split pane"]').click();
  await page.waitForFunction(() => window.qaLayout.kind === 'split' && window.qaLayout.first.kind === 'split');
  assert.equal((await layout()).second.id, 'right', 'splitting left retains the original right leaf');
  const rightAfterSplit=await box('[data-pane-id="right"]');
  near(rightAfterSplit.left,originalRight.left,'left split preserves original right left edge'); near(rightAfterSplit.width,originalRight.width,'left split preserves original right width');
  report.checks.push('two to three via left Split pane preserves original right leaf geometry');

  // Three horizontal panes: an inner drag must not move the outer divider or sibling.
  await page.evaluate(() => window.qaRender('three'));
  await page.waitForFunction(() => window.qaLayout.id === 'root-three');
  const outerBefore=await box(dividerTarget('root-three')), rightBefore=await box('[data-pane-id="right"]'), ratiosBefore=await ratios();
  await drag('left-three',.71); await assertOnlyRatio(ratiosBefore,'left-three');
  const outerAfter=await box(dividerTarget('root-three')), rightAfter=await box('[data-pane-id="right"]');
  near(outerAfter.left,outerBefore.left,'inner horizontal drag leaves outer divider fixed'); near(rightAfter.left,rightBefore.left,'inner horizontal drag leaves unrelated right sibling fixed'); near(rightAfter.width,rightBefore.width,'inner horizontal drag leaves unrelated right sibling width fixed');
  await assertDivider('left-three'); await assertDivider('root-three');
  const beforeOuter=await ratios(); await drag('root-three',.31); await assertOnlyRatio(beforeOuter,'root-three'); await assertDivider('root-three'); await assertDivider('left-three');
  report.checks.push('three horizontal panes isolate inner and outer ratio/geometry changes');

  // Four panes exercises both nested horizontal branches, repeated drags, and clamp limits.
  await page.evaluate(() => window.qaRender('four'));
  await page.waitForFunction(() => window.qaLayout.id === 'root-four');
  for (const [id,fractions] of Object.entries({ 'root-four':[.24,.78,.45], 'left-four':[.18,.84,.56], 'right-four':[.25,.75,.48] })) {
    for (const fraction of fractions) { const before=await ratios(); await drag(id,fraction); await assertOnlyRatio(before,id); await assertDivider(id); }
  }
  await drag('left-four',0); assert.equal((await ratios())['left-four'],.1,'minimum ratio clamps at 0.1'); await assertDivider('left-four');
  await drag('right-four',1); assert.equal((await ratios())['right-four'],.9,'maximum ratio clamps at 0.9'); await assertDivider('right-four');
  await assertFullyAllocated('four horizontal panes');
  report.checks.push('four horizontal panes survive repeated drags, limits, and full allocation');

  // Vertical nested branches verify the same contract on the Y axis.
  await page.evaluate(() => window.qaRender('mixed'));
  await page.waitForFunction(() => window.qaLayout.id === 'root-mixed');
  const rootBefore=await box(dividerTarget('root-mixed')), rightVerticalBefore=await box('[data-split-id="right-mixed"]'), mixedBefore=await ratios();
  await drag('left-mixed',.75); await assertOnlyRatio(mixedBefore,'left-mixed');
  const rootAfter=await box(dividerTarget('root-mixed')), rightVerticalAfter=await box('[data-split-id="right-mixed"]');
  near(rootAfter.left,rootBefore.left,'inner vertical drag leaves root divider fixed'); near(rightVerticalAfter.left,rightVerticalBefore.left,'inner vertical drag leaves unrelated branch fixed'); near(rightVerticalAfter.width,rightVerticalBefore.width,'inner vertical drag leaves unrelated branch width fixed');
  for (const [id,fraction] of [['root-mixed',.38],['right-mixed',.22],['left-mixed',.64]]) { const before=await ratios(); await drag(id,fraction); await assertOnlyRatio(before,id); await assertDivider(id); }
  await assertFullyAllocated('mixed panes');
  report.checks.push('mixed horizontal/vertical nested panes isolate addressed divider state');

  // Wrapper elements must not change fullscreen containment or restoration geometry.
  await page.evaluate(() => window.qaRender('three'));
  await page.waitForFunction(() => window.qaLayout.id === 'root-three');
  const leafBeforeFullscreen=await box('[data-pane-id="left-a"]');
  const workspace=await box('.pane-workspace');
  await page.locator('[data-pane-id="left-a"] button[aria-label="Fullscreen pane"]').click();
  const fullscreen=await box('[data-pane-id="left-a"].fullscreen');
  near(fullscreen.left,workspace.left+2,'fullscreen pane begins at workspace inset',2); near(fullscreen.top,workspace.top+2,'fullscreen pane begins at workspace top inset',2);
  near(fullscreen.right,workspace.right-2,'fullscreen pane ends at workspace inset',2); near(fullscreen.bottom,workspace.bottom-2,'fullscreen pane ends at workspace bottom inset',2);
  await page.locator('[data-pane-id="left-a"] button[aria-label="Fullscreen pane"]').click();
  const leafAfterRestore=await box('[data-pane-id="left-a"]');
  for (const side of ['left','top','right','bottom','width','height']) near(leafAfterRestore[side],leafBeforeFullscreen[side],`fullscreen restore preserves ${side}`,1);
  report.checks.push('nested fullscreen fills workspace and restores the original leaf geometry');

  for (const theme of ['light','dark']) for (const width of [1280,1440,1920]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(({theme}) => { document.documentElement.dataset.theme=theme; window.qaRender('mixed'); }, {theme});
    await page.waitForTimeout(50);
    const file=`${theme}-${width}-mixed.png`; await page.screenshot({path:join(out,file),animations:'disabled'}); report.screenshots.push(file);
  }
  report.geometry={finalLayout:await page.evaluate(() => window.qaLayout), errors};
  assert.deepEqual(errors,[],errors.join('\n'));
  report.passed=true;
} catch (error) {
  report.error=error instanceof Error ? error.stack : String(error);
  process.exitCode=1;
  if (app) await app.windows()[0]?.screenshot({path:join(out,'failure.png')}).catch(()=>{});
} finally {
  report.completedAt=new Date().toISOString();
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
  await app?.close().catch(()=>{});
  console.log(JSON.stringify({passed:report.passed,out,checks:report.checks},null,2));
}
