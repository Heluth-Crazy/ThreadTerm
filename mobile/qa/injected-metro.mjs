// Browser QA for the real CompanionApp under Expo Metro with a test-only NativePort.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd(), app = join(root, 'mobile', 'qa', 'app'), out = join(app, '.qa-export'), shots = join(root, 'mobile', '.qa-injected-shots');
mkdirSync(shots, { recursive: true });
execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32' ? ['/d', '/s', '/c', 'npx expo export --platform web --output-dir .qa-export'] : ['expo', 'export', '--platform', 'web', '--output-dir', '.qa-export'], { cwd: app, stdio: 'inherit', windowsHide: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer((req, res) => { const pathname = new URL(req.url ?? '/', 'http://qa').pathname, file = normalize(join(out, pathname === '/' ? 'index.html' : pathname.slice(1))); if (!file.startsWith(out) || !existsSync(file)) { res.writeHead(404); res.end(); return; } res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream'); res.end(readFileSync(file)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light', locale: 'en-US' }), errors = [];
page.setDefaultTimeout(8_000);
page.on('pageerror', error => errors.push(String(error)));
const shot = name => page.screenshot({ path: join(shots, `${name}-390x844.png`), fullPage: true });
const noOverflow = async step => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${step}: no horizontal overflow`);
try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await page.getByText('Choose QA mode').first().waitFor(); await noOverflow('needs-you'); await shot('needs-you-question');
  await page.getByRole('tab', { name: 'Projects' }).click(); await noOverflow('computers');await shot('computers');await page.getByRole('button', { name: 'Control PC' }).click();await shot('computer-projects');await page.getByRole('button', { name: 'Project alpha' }).click();await shot('project-sessions');
  await page.getByRole('button', { name: 'Files' }).click(); await page.getByRole('button', { name: 'README.md' }).click(); await page.getByText('fixture file from alpha').waitFor(); await noOverflow('file'); await shot('file-document');
  await page.getByRole('button', { name: 'Back' }).click(); await page.getByText('Files').waitFor(); await page.getByRole('button', { name: 'Back' }).click(); await page.getByText('Project alpha').waitFor();
  await page.getByRole('button', { name: 'Changes' }).click(); await page.getByRole('button', { name: 'Working' }).click(); await page.getByText('after').waitFor(); await noOverflow('git-diff'); await shot('git-diff');
  await page.getByRole('button', { name: 'Back' }).click(); await page.getByText('Changes').waitFor(); await page.getByRole('button', { name: 'Back' }).click(); await page.getByText('Project alpha').waitFor();
  await page.getByRole('button', { name: 'Review alpha' }).click(); await page.getByText('Which verification mode should run?').last().waitFor(); await page.getByRole('button', { name: 'Unlock' }).click(); await page.getByText('Safe').waitFor(); await noOverflow('control-question'); await shot('control-question');
  await page.getByRole('radio',{name:'Safe',exact:true}).click();await page.getByRole('button',{name:'Submit answer',exact:true}).click();
  await page.waitForFunction(()=>globalThis.__TT_MOBILE_QA_CALLS__.some(call=>call.method==='chat.answer'));
  const answer=await page.evaluate(()=>globalThis.__TT_MOBILE_QA_CALLS__.find(call=>call.method==='chat.answer'));
  assert.equal(answer.id,'alpha');assert.equal(answer.params.turnId,'turn-alpha');assert.equal(answer.params.approvalId,'question-alpha');assert.deepEqual(answer.params.response,{action:'submit',values:{mode:['Safe']}});
  await page.getByRole('button', { name: 'Back' }).click(); await page.getByRole('button', { name: 'Build terminal' }).click(); await page.getByText('qa shell build passed').waitFor(); await noOverflow('terminal'); await shot('terminal');
  await page.getByRole('button', { name: 'Back' }).click(); await page.getByRole('button', { name: 'Back' }).click(); await page.getByRole('button', { name: 'Back' }).click(); await page.getByRole('button', { name: 'Readonly PC' }).click(); await page.getByRole('button', { name: 'Project beta' }).click(); await page.getByRole('button', { name: 'Review beta' }).click(); await page.getByText('Readonly question').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true, 'readonly machine cannot send'); await noOverflow('readonly'); await shot('readonly-question');assert.equal(await page.getByRole('button',{name:'Submit answer',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>globalThis.__TT_MOBILE_QA_CALLS__.filter(call=>call.id==='beta'&&['chat.answer','chat.send','session.claim'].includes(call.method)).length),0);
  await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(100);await noOverflow('readonly-dark');await shot('readonly-dark');
  assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
  console.log('Injected Metro mobile QA passed: computer/project/session/files/git/terminal/question/readonly.');
} catch (error) { await shot('failure');console.error('Rendered text:',await page.locator('body').innerText());console.error('Page errors:',errors);throw error; } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
