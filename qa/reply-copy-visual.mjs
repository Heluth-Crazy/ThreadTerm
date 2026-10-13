// Isolated Electron visual regression for the Chat reply copy row and Markdown code-block copy.
// It uses the production ChatView and CSS bundle only; no runtime or provider starts, and the clipboard is an in-page fake.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'threadterm-reply-copy-'));
const out = resolve('qa', 'results', 'chat-parity', 'A2', 'reply-copy-isolated', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatView} from './renderer/src/components/ChatView';
import {I18nProvider} from './renderer/src/i18n';
import './renderer/src/styles.css';
const text = value => ({type:'text',text:value,status:'complete'});
const user = {id:'user',role:'user',turnId:'turn-done',createdAt:'now',parts:[text('Summarise the module')]};
const before = {id:'before',role:'assistant',turnId:'turn-done',createdAt:'now',parts:[{...text('Before  \\nNext line.\\n'),phase:'final_answer'}]};
const reply = {id:'reply',role:'assistant',turnId:'turn-done',createdAt:'now',elapsedMs:7000,turnStatus:'completed',parts:[
  {type:'thinking',text:'Private reasoning',status:'complete'},
  {type:'tool',toolName:'Read',toolId:'read-1',status:'complete',text:'renderer/src/replyMarkdown.ts'},
  text('# Answer\\n\\nThe copy action writes the reply Markdown.'),
  text('\\u0060\\u0060\\u0060ts\\nconst copied = true;\\n\\u0060\\u0060\\u0060'),
]};
const streaming = {id:'streaming',role:'assistant',turnId:'turn-live',createdAt:'now',turnStatus:'inProgress',parts:[{type:'text',text:'Still streaming',status:'streaming'}]};
const streamingTool = {id:'streaming-tool',role:'assistant',turnId:'turn-live',createdAt:'now',turnStatus:'inProgress',parts:[{type:'tool',toolId:'running-tool',toolName:'Bash',status:'running',data:{input:{command:'echo running'}}}]};
const transcript = [user, before, reply, streaming, streamingTool];
window.__copied = [];
window.threadterm = {
  onEvent: () => () => {},
  async request(method, params) {
    if (method === 'chat.snapshot') return { items: transcript, revision: 1 };
    if (method === 'chat.queue.read') return { sessionId: params.sessionId, paused: false, items: [] };
    if (method === 'chat.read') return [];
    if (method === 'chat.draft.read') return { text: '', revision: 0 };
    if (method === 'chat.feedback.read') return { notes: [] };
    if (method === 'chat.options') return { options: [], commands: [] };
    throw new Error('Unexpected QA request ' + method);
  },
};
Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copied.push(String(value)); } } });
const root = createRoot(document.getElementById('root'));
const session = {id:'reply-copy-qa',provider:'codex',mode:'chat',status:'idle',readOnly:true,title:'Reply copy QA',createdAt:'now',updatedAt:'now'};
window.qaRender = locale => root.render(<I18nProvider locale={locale}><ChatView session={session} /></I18nProvider>);
window.qaRender('en');
`;
await build({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, outfile: join(scratch, 'qa.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' } });
await writeFile(join(scratch, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="qa.css"><style>html,body{height:100%;margin:0}#root{height:100vh}</style><div id="root"></div><script src="qa.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(scratch, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
Object.assign(env, { PATH: [dirname(process.execPath), join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(';') });

const report = { passed: false, checks: [], screenshots: [] };
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs'), '--disable-gpu', '--in-process-gpu', '--no-sandbox'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const chat = page.locator('[data-testid="session-chat-reply-copy-qa"]');
  await chat.locator('article.has-reply-actions').first().waitFor();

  // E4 adds a reply Fork button with the shared chat-message-action class, so the
  // row (not the button class) is the per-reply anchor and Copy is counted by name.
  const actionRows = chat.locator('.chat-message-actions');
  assert.equal(await actionRows.count(), 1, 'only the completed reply owns the copy row');
  assert.equal(await actionRows.getByRole('button', { name: 'Copy' }).count(), 1, 'the completed reply row holds exactly one Copy button');
  const copyButton = actionRows.locator('button[aria-live="polite"]');
  assert.equal(await copyButton.count(), 1, 'the Copy button announces its copied state');
  assert.equal(await chat.locator('article.user .chat-message-actions').count(), 0, 'user messages have no copy row');
  assert.equal(await chat.locator('article').filter({ hasText: 'Still streaming' }).locator('.chat-message-actions').count(), 0, 'streaming replies have no copy row');
  report.checks.push('copy row only on the completed reply');

  const copyGeometry = await chat.locator('article.has-reply-actions').first().evaluate(article => {
    const before = article.getBoundingClientRect().height;
    const row = article.querySelector('.chat-message-actions');
    return { before, rowOpacity: getComputedStyle(row).opacity };
  });
  assert.equal(copyGeometry.rowOpacity, '0', 'the copy row is hidden until hover or focus');
  await copyButton.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('article.has-reply-actions .chat-message-actions')).opacity === '1');
  const hoveredGeometry = await chat.locator('article.has-reply-actions').first().evaluate(article => ({
    height: article.getBoundingClientRect().height,
    rowOpacity: getComputedStyle(article.querySelector('.chat-message-actions')).opacity,
  }));
  assert.equal(hoveredGeometry.rowOpacity, '1', 'the copy row appears on hover');
  assert.equal(hoveredGeometry.height, copyGeometry.before, 'hovering does not change message height');
  report.checks.push('hover reveals the row without changing message height');

  await copyButton.click();
  await page.waitForFunction(() => window.__copied.length === 1);
  const copiedReply = await page.evaluate(() => window.__copied[0]);
  assert.equal(copiedReply, 'Before  \nNext line.\n\n\n# Answer\n\nThe copy action writes the reply Markdown.\n\n```ts\nconst copied = true;\n```', 'reply copy joins every answer segment verbatim and excludes thinking and tool activity');
  await chat.locator('.chat-message-actions .chat-message-action').filter({ hasText: 'Copied' }).waitFor();
  assert.equal(await copyButton.textContent(), 'Copied', 'the label confirms the copy');
  report.checks.push('reply Copy writes Markdown only and confirms');

  const codeButton = chat.locator('.md-code-block .md-code-copy');
  assert.equal(await codeButton.count(), 1, 'the code block owns a copy button');
  await codeButton.click();
  await page.waitForFunction(() => window.__copied.length === 2);
  assert.equal(await page.evaluate(() => window.__copied[1]), 'const copied = true;\n', 'code copy writes only the code');
  report.checks.push('code-block Copy writes only the code');

  await copyButton.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__copied.length === 3);
  assert.equal(await page.evaluate(() => window.__copied[2]), copiedReply, 'keyboard Enter copies the reply');
  report.checks.push('keyboard Enter copies the reply');
  await page.waitForFunction(() => document.querySelector('.chat-message-actions .chat-message-action')?.textContent === 'Copy');

  for (const locale of ['en', 'zh-CN']) {
    await page.evaluate(next => window.qaRender(next), locale);
    await chat.locator('article.has-reply-actions').first().waitFor();
    const label = await copyButton.textContent();
    assert.equal(label, locale === 'zh-CN' ? '复制' : 'Copy', `${locale} copy label`);
  }
  report.checks.push('bilingual labels');

  await page.mouse.move(4, 4);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  for (const theme of ['light', 'dark']) {
    await page.evaluate(next => { document.documentElement.dataset.theme = next; }, theme);
    for (const width of [1280, 420]) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0].setContentSize(nextWidth, 900), width);
      for (const locale of ['en', 'zh-CN']) {
        await page.evaluate(next => window.qaRender(next), locale);
        await chat.locator('article.has-reply-actions').first().waitFor();
        const file = join(out, `${theme}-${width}-${locale}.png`);
        await page.screenshot({ path: file });
        report.screenshots.push(file);
        const overflow = await chat.locator('.chat-log-shell').evaluate(element => element.scrollWidth - element.clientWidth);
        assert.ok(overflow <= 1, `${theme} ${width} ${locale} must not scroll horizontally (overflow ${overflow})`);
        await chat.locator('article.has-reply-actions').first().hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('article.has-reply-actions .chat-message-actions')).opacity === '1');
        const hoverFile = join(out, `${theme}-${width}-${locale}-hover.png`);
        await page.screenshot({ path: hoverFile });
        report.screenshots.push(hoverFile);
        await page.mouse.move(4, 4);
      }
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  await page.evaluate(() => window.qaRender('en'));
  await chat.locator('article.has-reply-actions').first().waitFor();
  await copyButton.hover();
  await page.screenshot({ path: join(out, 'hover-en-light.png') });

  const replyConsistency = await checkControlConsistency(page, '.v3-chat-message.has-reply-actions');
  assertNoControlViolations(replyConsistency, 'reply actions');
  const codeConsistency = await checkControlConsistency(page, '.md-code-block');
  assertNoControlViolations(codeConsistency, 'code-block copy');
  report.checks.push(`zero visual-consistency violations (reply ${replyConsistency.checked}, code ${codeConsistency.checked} controls)`);

  report.passed = true;
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, out, checks: report.checks, copied: await page.evaluate(() => window.__copied) }));
} finally {
  await app?.close();
}
