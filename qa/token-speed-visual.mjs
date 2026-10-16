// Desktop-1 production-app QA. Fake native protocols only; no real agent CLI.
// Run after job F lands: node qa/token-speed-visual.mjs [--stress-follow]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { electron } from './lib/desktop1.mjs';
import { sendChatPrompt } from './lib/chat-send.mjs';
import { assertNoControlViolations, checkControlConsistency } from './lib/visual-consistency.mjs';
import { collectFooterPresentationInPage, ensureTranscriptLatest, estimateOutputTokens, excludesToolTime, footerSeparatorViolations, followStressPrompt, hasAppliedStressEvent, isolatedProviderEnvironment, observeTurnInPage, tokensPerSecond, transcriptFollowsLatest, transcriptFollowFailure, transcriptFollowSummary, waitForProviderChat, withinRelative } from './lib/token-speed.mjs';
import { TOKEN_SPEED_ACP_SCENARIO as acp } from './fixtures/token-speed-echo-acp/agent.mjs';
import codexFixture from './fixtures/fake-codex-token-speed.cjs';

const { TOKEN_SPEED_CODEX_SCENARIO: codex } = codexFixture;
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'qa/results/token-speed');
const runtime = join(root, 'runtime/target-qa/debug/threadterm-v3-runtime.exe');
const followStress = process.argv.includes('--stress-follow') ? Object.freeze({ repeats: 3, offsetPx: 173, loadMs: 32, layoutGrowthPx: 49 }) : null;
const scratchParent = followStress ? resolve('D:/project/ThreadTerm/tt-qa-temp') : tmpdir();
if (followStress) await mkdir(scratchParent, { recursive: true });
const scratch = await mkdtemp(join(scratchParent, 'tt-token-speed-'));
const appDir = join(scratch, 'app'), bin = join(scratch, 'bin'), work = join(scratch, 'work'), plugins = join(scratch, 'plugins');
const codexLog = join(scratch, 'codex.jsonl');
const report = { passed: false, checks: [], turns: [], screenshots: [], paneWidths: [], resizeFollow: [], turnFollow: [], scrollPositions: [], footerSeparators: [], visualConsistency: [], sendDiagnostics: [], errors: [], followStress, idleCheck: 'DOM fallback: the live push channel belongs to job F, so no channel name is assumed.' };
const custom = { background: '#0b1016', surface: '#182430', text: '#f2f6fb', muted: '#93a3b5', accent: '#ff7a45', border: '#26323f' };
let app, page, project;
const delay = ms => new Promise(done => setTimeout(done, ms));
const request = (method, params = {}) => page.evaluate(([name, value]) => window.threadterm.request(name, value), [method, params]);
const chatScope = id => page.locator(`[data-testid="session-chat-${id}"]`);
const check = value => { report.checks.push(value); console.log(`PASS ${value}`); };
async function until(probe, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) { const value = await probe(); if (value) return value; if (Date.now() >= end) throw new Error(`Timed out: ${label}`); await delay(80); }
}
async function shot(name) {
  await page.mouse.move(2, 2);
  await page.screenshot({ path: join(out, name), animations: 'disabled' });
  report.screenshots.push(name);
}

async function buildApp() {
  for (const name of ['main', 'preload']) await esbuild({ entryPoints: [join(root, `desktop/src/${name}.ts`)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: join(appDir, `${name}.cjs`), logLevel: 'error' });
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: join(appDir, 'renderer'), emptyOutDir: true } });
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'token-speed-qa', version: '0.1.0', main: 'main.cjs' }));
}

async function settings(theme, language) {
  const snapshot = await request('runtime.snapshot');
  const patch = { language, theme: theme === 'custom' ? 'dark' : theme, themeSelection: theme === 'custom' ? 'custom:qa' : theme,
    ...(theme === 'custom' ? { customThemes: { qa: custom } } : {}), notifications: { native: false, attention: false, completed: false, sound: false } };
  await request('settings.update', { patch, expectedRevision: snapshot.settings.revision, operationId: randomUUID() });
  await page.waitForFunction(([theme, language]) => document.documentElement.dataset.theme === (theme === 'custom' ? 'dark' : theme)
    && document.documentElement.lang === language, [theme, language]);
  if (theme === 'custom') {
    await page.waitForFunction(() => document.documentElement.dataset.customTheme === 'true');
    assert.equal((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim())).toLowerCase(), custom.surface);
  }
}

async function present(session) {
  await request('session.present', { sessionId: session.id, placement: 'workspace', presentation: 'focused', operationId: randomUUID() });
  await chatScope(session.id).waitFor();
  await until(async () => (await request('chat.connection', { sessionId: session.id })).phase === 'ready', 'fake provider connection ready');
}

// Same real split-and-drag geometry as chat-visual-consistency.mjs. The desktop
// stays at 1440 px so the horizontal layout cannot collapse to a vertical stack.
async function sizeChatPane(scope, width, label) {
  // Establish follow before resizing; no recovery click is allowed between
  // the before/after measurements or it would hide a product resize failure.
  await followLatestBeforeSend(scope, `${label} before resize`);
  const resize = { label, width, before: await measureTranscript(scope), followLostOnResize: null };
  report.resizeFollow.push(resize);
  const actions = () => page.getByRole('button', { name: /^(Workspace actions|工作区操作)$/ });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.waitForFunction(() => window.innerWidth === 1440);
  if (width === 1440) {
    const empty = page.locator('[data-pane-id]').filter({ has: page.locator('.pane-empty') });
    if (await empty.count()) {
      await empty.locator('.pane-empty > strong').click(); await actions().click();
      await page.getByRole('button', { name: /^(Close pane|关闭窗格)$/ }).click(); await page.keyboard.press('Escape');
      await until(async () => (await page.locator('[data-pane-id]').count()) === 1, 'single-pane wide layout');
    }
  } else {
    assert.equal(await page.locator('[data-pane-id]').count(), 1);
    await scope.locator('textarea').click(); await actions().click();
    await page.getByRole('button', { name: /^(Split right|左右拆分)$/ }).click(); await page.keyboard.press('Escape');
    await page.locator('.workspace-action-menu').waitFor({ state: 'hidden' });
    await until(async () => (await page.locator('[data-pane-id]').count()) === 2, 'two real workspace panes');
    const divider = page.locator('[data-split-id] > .pane-divider');
    await until(() => divider.evaluate(node => node.parentElement.classList.contains('horizontal')), 'horizontal split');
    const target = await divider.evaluate(node => {
      const box = node.parentElement.getBoundingClientRect(), rect = node.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(node.parentElement).columnGap) || 0;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, endX: box.left + 400 + gap + rect.width / 2 };
    });
    assert.equal(await divider.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), target), true);
    await page.mouse.move(target.x, target.y); await page.mouse.down(); await page.mouse.move(target.endX, target.y, { steps: 8 }); await page.mouse.up();
    await until(() => scope.evaluate(node => node.getBoundingClientRect().width >= 380 && node.getBoundingClientRect().width <= 420), 'Chat itself is 380–420 px');
  }
  const measured = await scope.evaluate(node => ({ chatWidth: node.getBoundingClientRect().width, paneWidth: node.closest('[data-pane-id]').getBoundingClientRect().width, viewportWidth: window.innerWidth }));
  report.paneWidths.push({ label, width, ...measured });
  assert.equal(measured.viewportWidth, 1440);
  if (width === 420) for (const key of ['chatWidth', 'paneWidth']) assert.ok(measured[key] >= 380 && measured[key] <= 420, `${label}: ${key} = ${measured[key]}`);
  else assert.ok(measured.chatWidth > 800, `${label}: wide Chat really is wide`);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  resize.after = await measureTranscript(scope);
  resize.followLostOnResize = !transcriptFollowsLatest(resize.after);
  if (resize.followLostOnResize) throw new Error(`product: resize dropped follow at ${label}: ${JSON.stringify(resize.after)}`);
}

async function indicatorValue(indicator, estimated) {
  await indicator.waitFor({ state: 'visible' });
  const value = await indicator.evaluate(node => ({ estimated: node.dataset.estimated, speed: node.dataset.tokensPerSecond, text: node.textContent.trim(), title: node.title }));
  assert.equal(value.estimated, String(estimated));
  assert.match(value.speed, /^\d+$/); assert.ok(Number(value.speed) > 0);
  assert.equal(value.text, `${estimated ? '≈ ' : ''}${value.speed} tok/s`);
  return { ...value, speed: Number(value.speed) };
}

async function fits(indicator, label) {
  const geometry = await indicator.evaluate(node => {
    const rect = node.getBoundingClientRect(), pane = node.closest('[data-pane-id]').getBoundingClientRect();
    const clippedBy = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1)) clippedBy.push(parent.className);
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) clippedBy.push(parent.className);
    }
    return { width: rect.width, height: rect.height, fontSize: getComputedStyle(node).fontSize, inside: rect.left >= pane.left - 1 && rect.right <= pane.right + 1 && rect.top >= 0 && rect.bottom <= innerHeight, clippedBy };
  });
  assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.inside, `${label}: indicator is inside the visible pane`);
  assert.equal(geometry.fontSize, '11px', `${label}: meta text uses the shared 11 px scale`);
  assert.deepEqual(geometry.clippedBy, [], `${label}: no ancestor clips the indicator`);
}

async function consistency(indicator, label, footer = false) {
  const tag = `speed-${randomUUID()}`;
  await indicator.evaluate((node, { tag, footer }) => {
    const surface = footer ? node.closest('[data-testid="chat-turn-footer"]') : (node.closest('[role="status"]') ?? node);
    if (!surface) throw new Error('missing token-speed surface');
    surface.setAttribute('data-qa-speed-surface', tag);
  }, { tag, footer });
  try {
    const result = await checkControlConsistency(page, `[data-qa-speed-surface="${tag}"]`, { checkStates: true, checkDisabledRows: true });
    report.visualConsistency.push({ label, ...result });
    // A read-only metadata row can legitimately have zero interactive controls.
    assertNoControlViolations(result, label);
  } finally {
    await page.locator(`[data-qa-speed-surface="${tag}"]`).evaluate(node => node.removeAttribute('data-qa-speed-surface')).catch(() => {});
  }
}

// Only QA observes the active Chat subtree. No F-specific live channel or state
// is assumed. Retain timestamps to compare the Codex live value to native events.
async function observeLive(scope, label, footerCount) {
  await scope.evaluate(observeTurnInPage, { id: randomUUID(), label, footerCount, stress: followStress });
}

async function collectTurnFollow(stop = false) {
  const probe = await page.evaluate(stop => {
    const probe = window.__tokenSpeedProbe;
    if (!probe) return null;
    if (stop) probe.stop('failure-cleanup');
    return { id: probe.id, label: probe.label, startedAt: probe.startedAt, endedAt: probe.endedAt, finished: probe.finished, stopReason: probe.stopReason, stress: probe.stress, samples: probe.followSamples };
  }, stop);
  if (!probe) return null;
  Object.assign(probe, transcriptFollowSummary(probe.samples));
  const index = report.turnFollow.findIndex(row => row.id === probe.id);
  if (index < 0) report.turnFollow.push(probe); else report.turnFollow[index] = probe;
  return probe;
}

function measureTranscript(scope) {
  return scope.evaluate(node => {
    const log = node.querySelector('.v3-chat-log'), control = node.querySelector('.chat-back-to-bottom');
    const rect = control?.getBoundingClientRect(), style = control ? getComputedStyle(control) : null;
    return { scrollTop: log.scrollTop, scrollHeight: log.scrollHeight, clientHeight: log.clientHeight,
      remainingPx: log.scrollHeight - log.clientHeight - log.scrollTop,
      jump: { present: Boolean(control), visible: Boolean(rect && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible'),
        rect: rect ? { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height } : null } };
  });
}

async function followLatestBeforeSend(scope, label) {
  const transcript = scope.locator('.v3-chat-log'), jump = scope.locator('.chat-back-to-bottom');
  const diagnostic = { label, status: 'pending' };
  // Record before waiting, so the failing cell is retained in report.json too.
  report.scrollPositions.push(diagnostic);
  await transcript.waitFor({ state: 'visible' });
  await ensureTranscriptLatest({
    label,
    measure: () => measureTranscript(scope),
    clickJump: () => jump.click({ timeout: 2_000 }),
    scrollToBottom: () => transcript.evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' })),
    settle: () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))),
    onDiagnostic: value => Object.assign(diagnostic, value),
  });
}

async function assertFooterSeparators(indicator, label) {
  const footer = indicator.locator('xpath=ancestor::*[@data-testid="chat-turn-footer"]');
  const presentation = await footer.evaluate(collectFooterPresentationInPage);
  const violations = footerSeparatorViolations(presentation);
  report.footerSeparators.push({ label, ...presentation, violations });
  assert.deepEqual(violations, [], `${label}: visible footer separators belong only between visible segments: ${presentation.renderedText ?? presentation.text}`);
}

async function sendTurn(session, prompt, label = prompt) {
  const scope = chatScope(session.id);
  await followLatestBeforeSend(scope, label);
  const baseline = new Set((await request('chat.snapshot', { sessionId: session.id })).items.map(item => item.id));
  const footerCount = await scope.getByTestId('turn-speed').count();
  await observeLive(scope, label, footerCount);
  await sendChatPrompt({ composer: scope.locator('.chat-compose-shell textarea'), sendButton: scope.locator('.chat-compose-send[type=submit]'), text: followStressPrompt(prompt, Boolean(followStress)),
    readSnapshot: () => request('chat.snapshot', { sessionId: session.id }), readConnection: () => request('chat.connection', { sessionId: session.id }),
    onDiagnostic: diagnostic => report.sendDiagnostics.push({ sessionId: session.id, ...diagnostic }) });
  return { scope, baseline, footerCount };
}

async function finishTurn(session, started) {
  const { scope, baseline, footerCount } = started;
  await until(async () => (await scope.getByTestId('turn-speed').count()) > footerCount, 'new completed turn speed footer');
  await until(async () => (await scope.getByTestId('turn-speed-live').count()) === 0, 'live speed disappears after completion');
  await until(() => page.evaluate(() => window.__tokenSpeedProbe.finished), 'active-turn follow sampler stops at completion');
  const follow = await collectTurnFollow();
  assert.ok(follow.startedAt !== null && follow.sampleCount > 0, 'follow sampling covers the actual submit through turn completion');
  if (followStress) {
    assert.ok(hasAppliedStressEvent(follow.stress), `${follow.label}: follow stress injected a positive stale scroll`);
  }
  const followFailure = transcriptFollowFailure(follow.label, follow.samples);
  if (followFailure) throw new Error(followFailure);
  if (followStress) assert.ok(follow.stress.layoutEvents.some(event => event.appliedGrowthPx === 49 && event.afterGrowth.remainingPx >= 49), `${follow.label}: follow stress injected 49 px growth before resize delivery`);
  const snapshot = await request('chat.snapshot', { sessionId: session.id });
  const item = snapshot.items.filter(item => !baseline.has(item.id) && item.turnUsage?.generationMs !== undefined).at(-1);
  assert.ok(item, 'new turn persists generationMs in chat.snapshot');
  assert.ok(Number.isFinite(item.turnUsage.firstTokenMs), 'new turn persists firstTokenMs');
  const samples = await page.evaluate(() => { window.__tokenSpeedProbe.observer.disconnect(); return window.__tokenSpeedProbe.samples; });
  assert.ok(samples.length > 0, 'live indicator was observed during the turn');
  return { scope, item, usage: item.turnUsage, samples, footer: scope.getByTestId('turn-speed').last() };
}

function assertFooterMath(value, usage) {
  assert.equal(value.speed, tokensPerSecond(usage.outputTokens, usage.generationMs), 'DOM speed matches persisted runtime usage exactly');
}

async function estimateTurn(session, label, language) {
  const started = await sendTurn(session, `Token speed estimate ${label}`, label);
  const live = started.scope.getByTestId('turn-speed-live');
  await indicatorValue(live, true); await fits(live, `${label} live`);
  await shot(`live-${label}.png`);
  await consistency(live, `${label} status`);
  const done = await finishTurn(session, started), value = await indicatorValue(done.footer, true);
  assertFooterMath(value, done.usage);
  const expectedTokens = estimateOutputTokens(acp.firstChunks.join('') + acp.secondChunks.join(''));
  const generationMs = acp.firstTokenMs + acp.firstStreamMs + acp.secondStreamMs;
  assert.equal(done.usage.outputTokensEstimated, true);
  assert.equal(done.usage.outputTokens, expectedTokens, 'ACP output count uses known streamed English/Chinese text');
  assert.ok(Math.abs(done.usage.firstTokenMs - acp.firstTokenMs) <= 400, `ACP first token ${done.usage.firstTokenMs} ms is 600 ±400 ms`);
  assert.ok(withinRelative(done.usage.generationMs, generationMs, 0.20), `generationMs ${done.usage.generationMs} excludes the tool run`);
  assert.ok(excludesToolTime(value.speed, expectedTokens, generationMs, acp.toolMs), `ACP speed ${value.speed} must match generation time and be closer to it than wall time`);
  const footer = done.footer.locator('xpath=ancestor::*[@data-testid="chat-turn-footer"]');
  assert.match((await footer.locator('.chat-turn-segment.is-out').innerText()).trim(), /^≈/, 'estimated output segment carries ≈');
  if (language === 'en') {
    assert.match(value.title, /Output tokens per second while the model was generating \(tool runs and waits excluded\)\./);
    assert.match(value.title, /First token after [\d.]+ s\./);
    assert.match(value.title, /This provider reports no token count; estimated from the streamed text\./);
  } else { assert.match(value.title, /[\u3400-\u9fff]/u, 'zh-CN tooltip is translated'); assert.doesNotMatch(value.title, /First token after|This provider reports/); }
  await done.footer.scrollIntoViewIfNeeded(); await fits(done.footer, `${label} footer`);
  await assertFooterSeparators(done.footer, label);
  await consistency(done.footer, `${label} footer`, true); await shot(`footer-${label}.png`);
  report.turns.push({ provider: 'token-speed-echo', label, expectedTokens, knownGenerationMs: generationMs, wholeTurnPrediction: tokensPerSecond(expectedTokens, generationMs + acp.toolMs), usage: done.usage, displayed: value, samples: done.samples });
  return done;
}

async function idle(done) {
  const before = await done.footer.evaluate(node => node.outerHTML);
  await done.scope.evaluate(node => {
    window.__tokenSpeedIdle = { changes: 0 };
    const probe = window.__tokenSpeedIdle;
    probe.observer = new MutationObserver(records => {
      if (records.some(record => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest('[data-testid="turn-speed-live"], [data-testid="turn-speed"]')
        || [...record.addedNodes, ...record.removedNodes].some(child => child.nodeType === 1 && (child.matches('[data-testid="turn-speed-live"], [data-testid="turn-speed"]') || child.querySelector('[data-testid="turn-speed-live"], [data-testid="turn-speed"]'))))) probe.changes += 1;
    });
    probe.observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-estimated', 'data-tokens-per-second'] });
  });
  await delay(2100);
  const changes = await page.evaluate(() => { window.__tokenSpeedIdle.observer.disconnect(); return window.__tokenSpeedIdle.changes; });
  assert.equal(await done.scope.getByTestId('turn-speed-live').count(), 0);
  assert.equal(await done.footer.evaluate(node => node.outerHTML), before);
  assert.equal(changes, 0, 'no speed-related DOM mutations for 2.1 s while idle');
  check('idle: live indicator absent and speed DOM static for 2.1 s (push-channel-independent fallback)');
}

async function persistence(session, done) {
  const before = await indicatorValue(done.footer, done.usage.outputTokensEstimated === true);
  await page.reload(); await page.waitForFunction(() => Boolean(window.threadterm));
  await page.locator('#boot-splash').waitFor({ state: 'detached' }); await present(session);
  const footer = chatScope(session.id).getByTestId('turn-speed').last(); await footer.scrollIntoViewIfNeeded();
  await assertFooterSeparators(footer, `${session.provider} after reload`);
  assert.deepEqual(await indicatorValue(footer, done.usage.outputTokensEstimated === true), before, 'reload preserves speed, exactness and tooltip');
  const snapshot = await request('chat.snapshot', { sessionId: session.id });
  assert.deepEqual(snapshot.items.find(item => item.id === done.item.id)?.turnUsage, done.usage, 'persisted timing and token fields survive window reload');
  check(`${session.provider}: reload preserves turnUsage and speed footer`);
}

async function exactTurn(session) {
  const started = await sendTurn(session, 'Two model calls with exact counts and one fake command', 'codex-exact');
  await indicatorValue(started.scope.getByTestId('turn-speed-live'), true);
  const done = await finishTurn(session, started), value = await indicatorValue(done.footer, false);
  assertFooterMath(value, done.usage);
  assert.equal(done.usage.outputTokensEstimated ?? false, false);
  const outSegment = done.footer.locator('xpath=ancestor::*[@data-testid="chat-turn-footer"]').locator('.chat-turn-segment.is-out');
  assert.doesNotMatch(value.text, /≈/);
  assert.doesNotMatch(await outSegment.innerText(), /≈/, 'exact output segment has no estimate prefix');
  assert.equal(done.usage.outputTokens, codex.firstOutputTokens + codex.secondOutputTokens, 'sum both per-call last output counts');
  const generationMs = codex.firstTokenMs + codex.firstStreamMs + codex.secondStreamMs;
  assert.ok(withinRelative(done.usage.generationMs, generationMs, 0.20), 'Codex generation time excludes the command');
  assert.ok(excludesToolTime(value.speed, codex.firstOutputTokens + codex.secondOutputTokens, generationMs, codex.toolMs), 'Codex speed is closer to generation time than whole-turn time');
  const log = (await readFile(codexLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const marker = name => { const entry = log.find(row => row.direction === 'marker' && row.method === name); assert.ok(entry, `Codex fixture marker ${name}`); return entry.at; };
  const turnStart = marker('turn-start'), firstUsage = marker('usage-first'), secondStart = marker('second-call-start');
  const toolMs = marker('tool-end') - marker('tool-start');
  const before = done.samples.filter(sample => sample.at < firstUsage && sample.speed > 0).at(-1);
  assert.ok(before, 'live estimate captured before the first usage event');
  const secondSamples = done.samples.filter(sample => sample.at >= secondStart + 500 && sample.at < secondStart + codex.secondStreamMs - 150);
  assert.ok(secondSamples.length, 'live speed captured during the second model call');
  const reflected = secondSamples.find(sample => {
    const secondText = log.filter(row => row.direction === 'out' && row.method === 'item/agentMessage/delta' && row.at >= secondStart && row.at <= sample.at).map(row => row.params.delta ?? '').join('');
    const expected = (codex.firstOutputTokens + estimateOutputTokens(secondText)) * 1000 / (sample.at - turnStart - toolMs);
    return sample.estimated === 'true' && withinRelative(sample.speed, expected) && sample.speed > before.speed * 1.5;
  });
  assert.ok(reflected, `second-call live speed replaces first-call estimate with exact ${codex.firstOutputTokens}: ${JSON.stringify({ before, secondSamples })}`);
  assert.doesNotMatch(value.title, /This provider reports no token count/);
  await done.footer.scrollIntoViewIfNeeded(); await fits(done.footer, 'Codex exact footer');
  await assertFooterSeparators(done.footer, 'Codex exact');
  await consistency(done.footer, 'Codex exact footer', true); await shot('footer-codex-exact.png');
  report.turns.push({ provider: 'codex', usage: done.usage, displayed: value, firstCallReplacement: { before, reflected }, samples: done.samples, nativeLog: log });
  check('Codex: two exact last counts sum in the footer; second-call live speed uses the first call exact count');
  await idle(done); await persistence(session, done);
}

try {
  assert.ok(existsSync(runtime), `missing ${runtime}; build target-qa runtime with job F before Desktop-1 QA`);
  await mkdir(out, { recursive: true });
  for (const path of [appDir, bin, work, plugins]) await mkdir(path, { recursive: true });
  await writeFile(codexLog, '');
  cpSync(join(root, 'qa/fixtures/token-speed-echo-acp'), join(plugins, 'token-speed-echo-acp'), { recursive: true });
  // Match the passing real-app browser QA. Runtime wraps .cmd launchers in
  // cmd.exe and %* forwards both login/status and -c ... app-server arguments.
  await writeFile(join(bin, 'codex.cmd'), `@"${process.execPath}" "${join(root, 'qa/fixtures/fake-codex-token-speed.cjs')}" %*\r\n`);
  await buildApp();
  const env = isolatedProviderEnvironment(process.env, { bin, nodeDir: dirname(process.execPath), system32: join(process.env.SystemRoot || 'C:\\Windows', 'System32') });
  Object.assign(env, { THREADTERM_V3_DATA: join(scratch, 'data'), THREADTERM_V3_USER_DATA: join(scratch, 'profile'), THREADTERM_V3_PIPE: `\\\\.\\pipe\\tt-token-speed-${randomUUID()}`,
    THREADTERM_V3_RUNTIME: runtime, THREADTERM_V3_PLUGIN_DIRS: plugins, CODEX_HOME: join(scratch, 'codex-home'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
    TT_QA_TOKEN_SPEED_CODEX_LOG: codexLog, TT_QA_TOKEN_SPEED_CODEX_CWD: work });
  assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), ['PATH']);
  for (const path of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.CODEX_HOME]) await mkdir(path, { recursive: true });
  process.env.TT_QA_DESKTOP = '1';
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', '--no-sandbox', appDir], cwd: bin, env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 45_000 }); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(error.message));
  if (followStress) page.on('console', message => { const value = message.text(); if (/^TOKEN SPEED FOLLOW (STRESS|LAYOUT) /.test(value)) console.log(value); });
  await page.waitForFunction(() => Boolean(window.threadterm)); await page.locator('.app-shell').waitFor();
  await page.locator('#boot-splash').waitFor({ state: 'detached', timeout: 30_000 });
  await settings('light', 'en');
  await until(async () => (await request('plugin.list')).plugins.some(row => row.id === 'token-speed-echo-acp'), 'ACP fixture discovery');
  await request('plugin.setEnabled', { pluginId: 'token-speed-echo-acp', enabled: true, operationId: randomUUID() });
  await until(async () => (await request('provider.list')).some(row => row.id === 'token-speed-echo' && row.chat), 'ACP fixture enabled');
  await waitForProviderChat({ provider: 'codex', label: 'native fake Codex discovered', readProviders: () => request('provider.list'), onDiagnostic: diagnostic => { report.providerDiscovery = diagnostic; } });
  project = await request('project.add', { path: work, name: 'Token speed QA', operationId: randomUUID() });
  const create = provider => request('session.create', { projectId: project.id, cwd: work, title: `Token speed ${provider}`, provider, mode: 'chat', operationId: randomUUID() });
  const exact = await create('codex'); await present(exact); await exactTurn(exact);
  const estimated = await create('token-speed-echo'); await present(estimated);
  for (const theme of ['light', 'dark', 'custom']) for (const language of ['en', 'zh-CN']) for (const width of [1440, 420]) {
    const label = `${theme}-${language}-${width}`;
    await settings(theme, language); const scope = chatScope(estimated.id); await sizeChatPane(scope, width, label);
    const done = await estimateTurn(estimated, label, language);
    await idle(done);
    if (label === 'light-en-1440') await persistence(estimated, done);
    check(`${label}: estimated live/footer, known timing and counts, no clipping, zero control violations`);
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  if (page) {
    try {
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const follow = await collectTurnFollow(true);
      const followFailure = follow && transcriptFollowFailure(follow.label, follow.samples);
      if (followFailure) { report.originalFailure = error.stack ?? String(error); error = new Error(followFailure); }
    } catch (probeError) { report.followProbeError = probeError.stack ?? String(probeError); }
  }
  report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
} finally {
  if (page) await page.evaluate(() => { window.__tokenSpeedProbe?.stop('cleanup'); window.__tokenSpeedIdle?.observer.disconnect(); }).catch(() => {});
  if (page) await request('runtime.shutdown', { operationId: randomUUID() }).catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  // Copy before deleting scratch so discovery failures retain CLI probe exits
  // and any app-server protocol errors even when no turn could be started.
  try { report.codexFixtureLog = (await readFile(codexLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { report.codexFixtureLogError = error.message; }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(dirname(resolve(scratch)), resolve(scratchParent), 'cleanup is confined to the owned scratch directory');
  assert.ok(basename(scratch).startsWith('tt-token-speed-'), 'cleanup targets this QA run only');
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
  console.log(report.passed ? 'TOKEN SPEED QA PASSED' : `TOKEN SPEED QA FAILED\n${report.errors.join('\n')}`);
}
