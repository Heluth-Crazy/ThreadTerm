// Isolated renderer integration: links to archives and programs (a .jar an agent built) get a "show in folder" button
// beside them in every Chat surface, and a file that is not text gets a panel whose way out is its folder. The real
// components render with a stub bridge; nothing reaches the OS.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { electron } from './lib/desktop1.mjs';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'qa/results/package-file-reveal');
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'tt-package-reveal-'));
const source = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {FileLinkedMarkdown,FileLinkedText,FileReferenceChips,FileReferenceScopeProvider} from './renderer/src/components/FileReferenceText';
import {ChatMarkdown} from './renderer/src/components/ChatMarkdownExtras';
import {BinaryFileView} from './renderer/src/components/BinaryFileView';
import './renderer/src/styles.css'; import './renderer/src/components/chat-network-notice.css';
window.__calls=[];window.__opens=[];
window.threadterm={onEvent:()=>()=>{},request:async(method,params)=>({projectId:'project',path:params.path,kind:'text'}),revealFileLocation:async target=>{window.__calls.push(target);return {kind:'file'};}};
const open=ref=>window.__opens.push(ref);
const copy=(en,zh)=>en;
createRoot(document.getElementById('root')).render(<main>
<FileReferenceScopeProvider sourceSessionId="build-session" canonicalRoot="D:/proj">
<section id="plain"><FileLinkedText text="Packaged target/app-1.0.jar from src/Main.java" openFile={open}/></section>
<section id="chips"><FileReferenceChips references={[{path:'build/libs/server.jar'},{path:'src/App.ts'}]} openFile={open}/></section>
<section id="markdown"><FileLinkedMarkdown sanitizedHtml='<p>Download <a href="target/app-1.0.jar">app-1.0.jar</a>, the installer dist/setup.exe, or read <a href="README.md">README.md</a>.</p>' references={[]} openFile={open}/></section>
<section id="rich"><ChatMarkdown sanitizedHtml='<p>Built <a href="out/bundle.zip">bundle.zip</a>.</p><pre><code class="language-json">{"ok":true}</code></pre>' references={[]} openFile={open} copy={copy} zh={false}/></section>
</FileReferenceScopeProvider>
<section id="unscoped"><FileReferenceChips references={[{path:'build/libs/orphan.jar'}]} openFile={open}/></section>
<section id="binary-zh" style={{height:300,display:'flex',border:'1px solid #ddd'}}><BinaryFileView path={"D:\\\\proj\\\\target\\\\app-1.0.jar"} target={{projectId:'project',path:'target/app-1.0.jar'}} zh={true}/></section>
<section id="binary-en" style={{height:300,display:'flex',border:'1px solid #ddd'}}><BinaryFileView path="dist/setup.exe" target={{projectId:'project',path:'dist/setup.exe'}} zh={false}/></section>
</main>);`;
await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(scratch, 'probe.js'), jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'error' });
await writeFile(join(scratch, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>main{padding:24px;max-width:760px}section{margin:16px 0}</style><div id="root"></div><script src="probe.js"></script>');
await writeFile(join(scratch, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:860,height:1100,show:true,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false}});w.loadFile(${JSON.stringify(join(scratch, 'index.html'))});});`);
const checks = [];
let app;
try {
  app = await electron.launch({ args: [join(scratch, 'main.cjs')], timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.locator('#plain .file-reference-link').first().waitFor();
  await page.locator('#markdown .file-reference-link').nth(2).waitFor();
  const reveals = section => page.locator(`${section} [data-testid="file-reference-package-reveal"]`);
  // Where the buttons are: one beside each archive or program link, none beside source files, none without a session.
  const layout = await page.evaluate(() => [...document.querySelectorAll('section')].map(section => ({ id: section.id,
    items: [...section.querySelectorAll('.file-reference-link, .file-reference-reveal')].map(node => node.classList.contains('file-reference-reveal') ? 'REVEAL' : node.textContent) })));
  const expect = { plain: ['target/app-1.0.jar', 'REVEAL', 'src/Main.java'], chips: ['build/libs/server.jar', 'REVEAL', 'src/App.ts'],
    markdown: ['app-1.0.jar', 'REVEAL', 'dist/setup.exe', 'REVEAL', 'README.md'], rich: ['bundle.zip', 'REVEAL'], unscoped: ['build/libs/orphan.jar'] };
  for (const [id, items] of Object.entries(expect)) assert.deepEqual(layout.find(row => row.id === id)?.items, items, id);
  checks.push('a reveal button sits right after each archive or program link (plain text, chips, Markdown, rich Markdown) and nowhere else');
  // Each button reveals its own file through the source session and never opens the file.
  const cases = [['#plain', 0, 'target/app-1.0.jar'], ['#chips', 0, 'build/libs/server.jar'], ['#markdown', 0, 'target/app-1.0.jar'], ['#markdown', 1, 'dist/setup.exe'], ['#rich', 0, 'out/bundle.zip']];
  let clicked = 0;
  for (const [section, index] of cases) {
    await reveals(section).nth(index).click();
    await page.waitForFunction(count => window.__calls.length === count, ++clicked);
  }
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls, cases.map(([, , path]) => ({ sessionId: 'build-session', path })));
  assert.equal(await page.evaluate(() => window.__opens.length), 0, 'the reveal button does not open the file');
  checks.push('each button asks to reveal its own file through the source session and opens nothing');
  await page.locator('#plain .file-reference-link').first().click();
  await page.locator('#markdown .file-reference-link').first().click();
  assert.deepEqual(await page.evaluate(() => window.__opens.map(ref => ref.path)), ['target/app-1.0.jar', 'target/app-1.0.jar']);
  checks.push('clicking the link itself still opens the file');
  const label = await reveals('#plain').first().getAttribute('aria-label');
  assert.match(label, /^Reveal in Explorer: target\/app-1\.0\.jar$/);
  const box = await reveals('#plain').first().boundingBox(), link = await page.locator('#plain .file-reference-link').first().boundingBox();
  assert.ok(box.x >= link.x + link.width && box.x - (link.x + link.width) <= 6 && Math.abs(box.y + box.height / 2 - (link.y + link.height / 2)) <= 4, `the button sits on the link's line, right after it ${JSON.stringify({ box, link })}`);
  checks.push(`the button is labelled "${label}" and sits on the link's line`);
  await page.locator('#plain').screenshot({ path: join(out, 'chat-plain.png') });
  await page.locator('#markdown').screenshot({ path: join(out, 'chat-markdown.png') });
  // The panel for a file that is not text.
  assert.equal(await page.locator('#binary-zh .binary-file-name').innerText(), 'app-1.0.jar');
  assert.match(await page.locator('#binary-zh .binary-file-note').innerText(), /不是文本/);
  assert.equal((await page.locator('#binary-zh [data-testid="binary-file-reveal"]').innerText()).trim(), '在资源管理器中显示');
  assert.equal((await page.locator('#binary-en [data-testid="binary-file-reveal"]').innerText()).trim(), 'Reveal in Explorer');
  await page.locator('#binary-zh [data-testid="binary-file-reveal"]').click();
  await page.waitForFunction(count => window.__calls.length === count, cases.length + 1);
  assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), { projectId: 'project', path: 'target/app-1.0.jar' });
  checks.push('the not-text panel names the file, says why, and its primary button reveals it');
  await page.locator('#binary-zh').screenshot({ path: join(out, 'binary-panel-zh.png') });
  await page.locator('#binary-en').screenshot({ path: join(out, 'binary-panel-en.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, out }, null, 2));
} finally {
  await app?.close().catch(() => {});
}
