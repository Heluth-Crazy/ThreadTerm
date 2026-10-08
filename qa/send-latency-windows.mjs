// Desktop-1 real-runtime QA; main owns launch. --selftest is offline only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { electron } from './lib/desktop1.mjs';
assert.equal(process.platform, 'win32');
const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
const selftest = process.argv.includes('--selftest'), keep = process.argv.includes('--keep'), runtime = arg('--runtime');
if (!selftest)
    assert.ok(runtime && existsSync(runtime), 'pass --runtime');
process.env.TT_QA_DESKTOP = '1';
const root = resolve(import.meta.dirname, '..'), scratch = await mkdtemp(join(tmpdir(), 'tt-send-latency-')), repo = join(scratch, 'repo'), bin = join(scratch, 'bin'), gate = join(scratch, 'git.gate'), release = join(scratch, 'fake.release'), fakeLog = join(scratch, 'fake.jsonl'), gitLog = join(scratch, 'git.jsonl'), out = join(root, 'qa', 'results', 'send-latency-followup'), fixture = join(root, 'qa', 'fixtures', 'fake-codex-latency.cjs');
const report = { passed: false, scratch: keep ? scratch : undefined, checks: [], stages: [], screenshots: [] };
let app, page, session;
const where = x => execFileSync('where', [x], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean), realGit = where('git'), python = where('python');
assert.ok(realGit && python);
const host = a => execFileSync(realGit, a, { cwd: repo, stdio: 'pipe', windowsHide: true }), wait = ms => new Promise(r => setTimeout(r, ms));
async function until(f, name, ms = 15000) { const e = Date.now() + ms; while (Date.now() < e) {
    const v = await f();
    if (v)
        return v;
    await wait(80);
} throw Error(`Timed out: ${name}`); }
const rows = async (f) => (await readFile(f, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const alive = pid => { try {
    process.kill(pid, 0);
    return true;
}
catch {
    return false;
} };
async function compile() { await writeFile(join(scratch, 'git.rs'), String.raw `use std::{env,fs,process::{Command,Stdio},thread,time::Duration,os::windows::process::CommandExt};const H:u32=0x08000000;fn main(){let a:Vec<_>=env::args_os().skip(1).collect();let t=a.iter().map(|x|x.to_string_lossy()).collect::<Vec<_>>().join(" ");let g=env::var("TT_QA_GIT_GATE").unwrap();let m=fs::read_to_string(&g).unwrap_or_default();let h=(m.trim()=="catalog"&&t.contains("branch --show-current"))||(m.trim()=="checkpoint"&&t.contains("--is-inside-work-tree"));if h{fs::write(env::var("TT_QA_GIT_LOG").unwrap(),format!("held:{}:{}:{}\\n",m.trim(),std::process::id(),t)).ok();while fs::read_to_string(&g).unwrap_or_default().trim()==m.trim(){thread::sleep(Duration::from_millis(30));}}let s=Command::new(env::var_os("TT_QA_REAL_GIT").unwrap()).args(a).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).creation_flags(H).status().unwrap();std::process::exit(s.code().unwrap_or(1));}`); execFileSync('rustc', [join(scratch, 'git.rs'), '-O', '-o', join(bin, 'git.exe')], { stdio: 'pipe', windowsHide: true }); await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`); }
function env() { const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|threadterm_|codex|claude|grok|gemini|opencode|tt_qa_)/i.test(k))); Object.assign(e, { Path: [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'), THREADTERM_V3_RUNTIME: resolve(runtime ?? 'selftest'), THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-send-latency-${randomUUID()}`, TT_QA_REAL_GIT: realGit, TT_QA_GIT_GATE: gate, TT_QA_GIT_LOG: gitLog, TT_QA_FAKE_CODEX_LOG: fakeLog, TT_QA_FAKE_CODEX_CWD: repo, TT_QA_FAKE_RELEASE_FILE: release, TT_QA_PYTHON: python, TT_QA_RUNTIME_DB: join(scratch, 'data', 'threadterm-v3.sqlite3'), TT_QA_PROMPT: 'one fake prompt' }); assert.deepEqual(e.Path.split(';'), [bin, dirname(process.execPath), join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]); assert.ok(existsSync(join(bin, 'codex.cmd'))); return e; }
async function fixtureTest() { execFileSync(process.execPath, [fixture, '-c', 'model=qa', 'app-server', '--protocol-selftest'], { windowsHide: true, stdio: 'pipe' }); report.checks.push('fake Codex accepts config arguments before app-server'); }
async function shimTest() { const e = { ...env(), Path: `${bin};${process.env.Path}` }, run = (a, input) => execFileSync(join(bin, 'git.exe'), a, { cwd: repo, env: e, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); assert.equal(run(['rev-parse', '--show-toplevel']).trim().replaceAll('/', '\\'), repo); let bad = false; try {
    run(['show', 'definitely-not-a-revision']);
}
catch (x) {
    bad = true;
    assert.notEqual(x.status, 0);
    assert.ok(String(x.stderr).length);
} assert.ok(bad); await writeFile(join(repo, 'stdin-index.txt'), 'x'); run(['update-index', '--add', '--stdin'], 'stdin-index.txt\n'); assert.match(run(['ls-files']), /stdin-index.txt/); report.checks.push('offline shim preserved argv/stdout/stderr/stdin'); }
try {
    await mkdir(out, { recursive: true });
    await mkdir(repo, { recursive: true });
    await mkdir(bin, { recursive: true });
    host(['init']);
    host(['config', 'user.email', 'qa@example.test']);
    host(['config', 'user.name', 'QA']);
    await writeFile(join(repo, 'README.md'), 'x');
    host(['add', '.']);
    host(['commit', '-m', 'base']);
    await compile();
    await fixtureTest();
    await shimTest();
    if (selftest)
        report.passed = true;
    else {
        app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', root], cwd: bin, env: env(), timeout: 60000 });
        page = await app.firstWindow({ timeout: 30000 });
        await page.waitForFunction(() => Boolean(window.threadterm));
        const rpc = (m, p = {}) => page.evaluate(([a, b]) => window.threadterm.request(a, b), [m, p]);
        let snap = await rpc('runtime.snapshot');
        await rpc('settings.update', { patch: { language: 'en', theme: 'light', notifications: { native: false, attention: false, completed: false, sound: false } }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
        const project = await rpc('project.add', { path: repo, name: 'Latency QA', operationId: randomUUID() });
        session = await rpc('session.create', { projectId: project.id, cwd: repo, title: 'Latency QA', provider: 'codex', mode: 'chat', operationId: randomUUID() });
        await rpc('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
        await until(async () => (await rpc('chat.connection', { sessionId: session.id })).phase === 'ready', 'fake ready');
        if (!process.argv.includes('--only-checkpoint')) {
            const orderedProbe = async () => { const now = await rpc('runtime.snapshot'); return rpc('settings.update', { patch: { theme: 'light' }, expectedRevision: now.settings.revision, operationId: randomUUID() }); };
            const b = Date.now();
            await rpc('project.catalog.list');
            report.catalogBaselineMs = Date.now() - b;
            await writeFile(gate, 'catalog');
            let catalogError;
            const cat = rpc('project.catalog.list').catch(error => { catalogError = error; });
            await until(async () => (await readFile(gitLog, 'utf8').catch(() => '')).includes('held:catalog:'), 'held catalog');
            let t = Date.now();
            await orderedProbe();
            report.catalogOrderedProbeMs = Date.now() - t;
            assert.ok(report.catalogOrderedProbeMs < 1500, 'ordered settings update blocked behind held catalog');
            t = Date.now();
            await rpc('runtime.health');
            report.catalogHealthMs = Date.now() - t;
            assert.ok(report.catalogHealthMs < 1500);
            await writeFile(gate, 'release');
            await cat;
            if (catalogError)
                throw catalogError;
            report.checks.push('held catalog Git did not block ordered settings update or health');
        }
        await writeFile(gate, 'checkpoint');
        const box = page.locator(`[data-testid="session-chat-${session.id}"]`).getByRole('textbox'), started = Date.now();
        await box.fill('one fake prompt');
        await box.press('Enter');
        const heldLine = await until(async () => (await readFile(gitLog, 'utf8').catch(() => '')).split(/\r?\n/).find(x => x.startsWith('held:checkpoint:')), 'checkpoint Git held');
        const [, , pidText] = heldLine.split(':');
        const pid = Number(pidText);
        assert.ok(Number.isSafeInteger(pid) && pid > 0, 'invalid checkpoint shim PID');
        assert.equal(alive(pid), true, 'checkpoint shim was not observed alive while held');
        report.checkpointHeld = { pid, observedAt: Date.now(), wasAlive: true };
        const start = await until(async () => (await rows(fakeLog)).find(x => x.direction === 'in' && x.method === 'turn/start'), 'native prompt', 12000);
        report.sendToProviderMs = start.at - started;
        assert.ok(report.sendToProviderMs >= 9500 && report.sendToProviderMs <= 11500, `prompt took ${report.sendToProviderMs}ms`);
        assert.equal(start.durableUser, true, 'user was not durable before dispatch');
        await until(() => !alive(pid), 'checkpoint Git child killed by deadline', 3000);
        report.checkpointHeld.childGoneBeforeRelease = !alive(pid);
        assert.equal(report.checkpointHeld.childGoneBeforeRelease, true, 'checkpoint Git child survived deadline');
        await writeFile(gate, 'release');
        const review = await until(async () => { const value = await rpc('review.list', { sessionId: session.id }); return value?.available && value.checkpoints?.find(x => x.status === 'failed' && x.turnId && /git_timeout/i.test(String(x.error))) && value; }, 'failed git_timeout checkpoint', 5000);
        report.reviewAfterDeadline = review;
        for (const [language, theme, width] of [['en', 'light', 1280], ['en', 'dark', 420], ['zh-CN', 'light', 1280], ['zh-CN', 'dark', 420]]) {
            snap = await rpc('runtime.snapshot');
            await rpc('settings.update', { patch: { language, theme }, expectedRevision: snap.settings.revision, operationId: randomUUID() });
            const actual = await app.evaluate(({ BrowserWindow }, w) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(w, 900); return win.getContentSize(); }, width === 420 ? 960 : 1280);
            const chat = page.locator(`[data-testid="session-chat-${session.id}"]`);
            await chat.evaluate((el, narrow) => { el.style.width = narrow ? '420px' : ''; el.style.maxWidth = narrow ? '420px' : ''; el.style.flex = narrow ? '0 0 420px' : ''; }, width === 420);
            await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
            const thinking = language === 'zh-CN' ? '思考中' : 'Thinking';
            await until(async () => (await chat.locator('.chat-first-response-wait').innerText()).includes(thinking), 'localized Thinking after acknowledgment');
            assert.ok(!/Sending|正在发送/.test(await chat.innerText()), 'sending indicator persisted after acknowledgment');
            const bounds = await chat.boundingBox();
            assert.ok(bounds && (width === 420 ? Math.abs(bounds.width - 420) < 3 : bounds.width > 700), 'chat pane geometry mismatch');
            (report.visuals ??= []).push({ language, theme, windowWidth: actual[0], paneWidth: bounds.width });
            const n = `thinking-${language}-${theme}-${width}.png`;
            await chat.screenshot({ path: join(out, n) });
            report.screenshots.push(n);
        }
        await writeFile(release, 'go');
        await until(async () => (await rpc('chat.read', { sessionId: session.id })).some(x => x.parts.some(p => p.text === 'fake latency answer')), 'fake answer');
        assert.equal((await rows(fakeLog)).filter(x => x.direction === 'in' && x.method === 'turn/start').length, 1);
        report.checks.push('one native prompt after bounded failed checkpoint');
        report.passed = true;
    }
}
catch (e) {
    report.error = e instanceof Error ? e.stack : String(e);
    if (page)
        await page.screenshot({ path: join(out, 'failure.png') }).catch(() => { });
    process.exitCode = 1;
}
finally {
    await writeFile(gate, 'release').catch(() => { });
    await writeFile(release, 'go').catch(() => { });
    if (page)
        await page.evaluate(() => window.threadterm.request('runtime.shutdown', { operationId: crypto.randomUUID() })).catch(() => { });
    if (app) {
        await app.evaluate(({ app }) => app.exit(0)).catch(() => { });
        await app.close().catch(() => { });
    }
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const tmp = resolve(tmpdir()), safe = resolve(scratch);
    assert.ok(safe.startsWith(`${tmp}\\tt-send-latency-`));
    if (!keep)
        await rm(scratch, { recursive: true, force: true });
    console.log(JSON.stringify(report));
}
