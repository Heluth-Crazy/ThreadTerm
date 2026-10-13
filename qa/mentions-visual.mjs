// Isolated Electron visual regression for the Chat `@` mention popup. It renders
// the production ChatMentions component with the real grouping module and fake
// sources only; no runtime or provider starts. The matrix is wide/420 px ×
// light/dark/custom × en/zh-CN.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-mentions-'));
const out = resolve('qa', 'results', 'chat-parity', 'E3', 'mentions-isolated', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });

const entry = `
window.__qaLoaded = true;
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatMentions} from './renderer/src/components/ChatMentions';
import {agentMentionItems, commitMentionItems, fileMentionItems, mentionGroups, sessionMentionItems, skillMentionItems} from './renderer/src/chatMentions';
import './renderer/src/styles.css';
const paths = ['packages/very-long-directory-name/src/internal/components/a-rather-long-file-name-here.tsx'].concat(Array.from({length:12},(_,i)=>'src/feature-'+i+'.ts'),['README.md','docs/guide.md']);
const sessions = [
  {id:'other-1',projectId:'p1',title:'Refactor billing',provider:'codex',mode:'chat',status:'idle',createdAt:'now',updatedAt:'2026-03-02T00:00:00.000Z'},
  {id:'other-2',projectId:'p2',title:'Docs pass',provider:'claude',mode:'chat',status:'idle',createdAt:'now',updatedAt:'2026-03-01T00:00:00.000Z'},
];
const commits = [
  {hash:'6e0f22b1234567890abcdef1234567890abcdef1',subject:'Fix cart totals',authorName:'Ada',parents:[],authorEmail:'a@b.c',authoredAt:'now',refs:[]},
  {hash:'abc1234',subject:'Add checkout',authorName:'Lin',parents:[],authorEmail:'a@b.c',authoredAt:'now',refs:[]},
];
const agents = [
  {id:'codex',name:'Codex',installed:true,chat:true,terminal:false,history:false,resume:false},
  {id:'pi',name:'Pi',installed:true,chat:true,terminal:false,history:false,resume:false},
];
const sources = {
  files: fileMentionItems(paths),
  sessions: sessionMentionItems(sessions, 'self', 'p1'),
  commits: commitMentionItems(commits),
  agents: agentMentionItems(agents, 'claude'),
  skills: skillMentionItems([{name:'review',description:'Review code',invocation:'/skill:review'},{name:'plan',description:'Plan work',invocation:'/skill:plan'}]),
};
const groups = mentionGroups(sources, '');
window.__picked = [];
const view = {index:0, zh:false};
const root = createRoot(document.getElementById('root'));
window.qaRender = next => { Object.assign(view, next); root.render(<ChatMentions groups={groups} index={view.index} zh={view.zh} onHover={()=>{}} onPick={item => { window.__picked.push(item.item); }} />); };
window.qaRender({});
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{margin:0;background:var(--bg);color:var(--text)}#frame{width:420px;margin:24px auto}.chat-slash{position:static;max-height:none;left:auto;right:auto;bottom:auto}</style><div id="frame"><div id="root"></div></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
Object.assign(env, { PATH: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';') });

const report = { passed: false, checks: [], screenshots: [] };
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs'), '--disable-gpu', '--in-process-gpu', '--no-sandbox'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const popup = page.locator('.chat-mentions');
  await page.waitForFunction(() => document.querySelector('.chat-mentions') !== null, null, { timeout: 10_000 }).catch(async () => {
    const body = await page.evaluate(() => document.body.innerHTML).catch(() => 'unavailable');
    const state = await page.evaluate(() => ({ loaded: Boolean(window.__qaLoaded), scripts: Array.from(document.scripts).map(script => script.src) })).catch(() => 'unavailable');
    throw new Error(`mention popup did not render; page errors: ${pageErrors.join(' | ') || 'none'}; state: ${JSON.stringify(state)}; body: ${body.slice(0, 200)}`);
  });
  await popup.waitFor();
  const groupIds = await popup.locator('.mention-group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')));
  assert.deepEqual(groupIds, ['Files', 'Sessions', 'Commits', 'Agents', 'Skills'], 'all five groups render in order');
  assert.equal(await popup.locator('[data-testid="mention-option"]').count(), 8 + 2 + 2 + 2 + 2, 'each group is capped at eight rows');
  await popup.locator('.mention-group').first().locator('.mention-group-head small').waitFor();
  assert.equal(await popup.locator('.mention-group').first().locator('.mention-group-head small').textContent(), 'More results — keep typing to filter', 'the files group announces narrower typing');
  report.checks.push('five groups, eight-row cap, more-results note');

  const fileRows = popup.locator('[data-testid="mention-option"][data-mention-group="files"]');
  const heights = await fileRows.evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height)));
  assert.equal(new Set(heights).size, 1, 'rows in a group share one height');
  assert.equal(await fileRows.nth(0).getAttribute('aria-selected'), 'true', 'the first row starts active');
  await page.evaluate(() => window.qaRender({ index: 3 }));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="mention-option"]')[3]?.getAttribute('aria-selected') === 'true');
  await page.locator('[data-testid="mention-option"]').nth(3).click();
  assert.deepEqual(await page.evaluate(() => window.__picked.map(item => item.kind)), ['file'], 'clicking a row reports the typed item');
  report.checks.push('keyboard/active row, single height, pick reports the item');

  for (const locale of ['en', 'zh-CN']) {
    const expectedLabels = locale === 'zh-CN' ? ['文件', '会话', '提交', '代理', '技能'] : ['Files', 'Sessions', 'Commits', 'Agents', 'Skills'];
    await page.evaluate(zh => window.qaRender({ zh }), locale === 'zh-CN');
    await page.waitForFunction(expected => document.querySelector('.mention-group')?.getAttribute('aria-label') === expected, expectedLabels[0]);
    const labels = await popup.locator('.mention-group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')));
    assert.deepEqual(labels, expectedLabels, `${locale} group labels`);
  }
  report.checks.push('bilingual group labels');

  for (const theme of ['light', 'dark', 'custom']) {
    await page.evaluate(next => {
      document.documentElement.dataset.theme = next === 'custom' ? 'dark' : next;
      document.documentElement.dataset.customTheme = next === 'custom' ? 'true' : 'false';
      if (next === 'custom') {
        document.documentElement.style.setProperty('--primary', '#b45309');
        document.documentElement.style.setProperty('--surface', '#241a10');
        document.documentElement.style.setProperty('--bg', '#1a120b');
        document.documentElement.style.setProperty('--text', '#f5e9dc');
        document.documentElement.style.setProperty('--border', '#5a442b');
      }
    }, theme);
    for (const width of [1280, 420]) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
      for (const zh of [false, true]) {
        await page.evaluate(value => window.qaRender({ zh: value }), zh);
        await page.waitForFunction(expected => document.querySelector('.mention-group')?.getAttribute('aria-label') === expected, zh ? '文件' : 'Files');
        const file = join(out, `${theme}-${width}-${zh ? 'zh-CN' : 'en'}.png`);
        await page.screenshot({ path: file });
        report.screenshots.push(file);
        const overflow = await page.locator('#frame').evaluate(element => element.scrollWidth - element.clientWidth);
        assert.ok(overflow <= 1, `${theme} ${width} ${zh ? 'zh' : 'en'} popup must not scroll horizontally (overflow ${overflow})`);
        const clipped = await popup.evaluate(element => element.scrollWidth - element.clientWidth);
        assert.ok(clipped <= 1, `${theme} ${width} ${zh ? 'zh' : 'en'} popup content must not clip (overflow ${clipped})`);
      }
    }
  }
  report.checks.push('matrix without horizontal overflow or clipping');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.customTheme = 'false'; window.qaRender({ zh: false, index: 0 }); });
  await page.waitForFunction(() => document.querySelector('.mention-group')?.getAttribute('aria-label') === 'Files');
  const consistency = await checkControlConsistency(page, '.chat-mentions');
  assertNoControlViolations(consistency, 'mention popup');
  report.checks.push(`zero visual-consistency violations (${consistency.checked} controls)`);

  report.passed = true;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, out, checks: report.checks, screenshots: report.screenshots.length }));
} finally {
  await app?.close();
}
