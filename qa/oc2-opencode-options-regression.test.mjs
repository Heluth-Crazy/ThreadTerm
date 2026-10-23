import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(resolve('qa/opencode-options-visual.mjs'), 'utf8');
const tree = ts.createSourceFile('opencode-options-visual.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declaration(name) {
  let found;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(found, `missing production visual helper ${name}`); return found;
}
function selections(texts) {
  let clock = 0, reads = 0;
  const requests = [], waits = [], report = { timeouts: [] };
  const precise = JSON.stringify({ providerID: 'openai', modelID: 'gpt-5.2' });
  const ui = { options: [{ id: 'next-model', value: precise }, { id: 'agent', value: 'plan' }, { id: 'variant', value: 'precise' }] };
  const context = vm.createContext({
    precise, chat: { id: 'fixture' }, report,
    Date: { now: () => clock }, delay: async ms => { clock += ms; },
    step: label => { report.step = label; waits.push(label); }, console: { error() {} },
    observeConnection: async () => ({ phase: 'ready' }),
    option: (state, id) => state.options.find(row => row.id === id),
    request: async method => { requests.push(method); assert.equal(method, 'chat.options', 'waiting never sends a provider mutation'); return ui; },
    scope: { locator(selector) { assert.equal(selector, '.chat-compose-bar'); return { innerText: async () => texts[Math.min(reads++, texts.length - 1)] }; } },
  });
  vm.runInContext(`${declaration('until')}\n${declaration('applyPopulatedSelections')}\nglobalThis.run = applyPopulatedSelections;`, context);
  return { run: () => context.run(), requests, waits, report, reads: () => reads };
}

test('OpenCode populated visual waits for rendered chips after runtime options are already committed', async () => {
  const fixture = selections(['OpenCode default', 'OpenAI · GPT 5.2 Plan', 'OpenAI · GPT 5.2 Plan precise']);
  await fixture.run();
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.reads(), 3, 'both stale DOM frames must be passed before the caller can assert/capture');
  assert.ok(fixture.waits.includes('wait: rendered populated composer'));
});

test('OpenCode populated visual still fails when a selected chip never renders', async () => {
  const fixture = selections(['OpenAI · GPT 5.2 Plan']);
  await assert.rejects(fixture.run(), /Timed out waiting for rendered populated composer/);
  assert.equal(fixture.report.timeouts.length, 1);
  assert.equal(fixture.report.timeouts[0].observed.phase, 'ready', 'ready connection alone cannot pass the visual');
});

test('OpenCode populated visual accepts an already committed composer without waiting another frame', async () => {
  const fixture = selections(['OpenAI · GPT 5.2 Plan precise']);
  await fixture.run(); assert.equal(fixture.reads(), 1);
});

test('OpenCode connecting capture precedes slow control checks while retaining layout validation', async () => {
  let clock = 0;
  const events = [], report = { screenshots: [], observations: [], paneWidths: [] };
  const context = vm.createContext({
    assert, report, chat: { id: 'fixture' }, out: 'captures', join: (...parts) => parts.join('/'), step() {},
    observeConnection: async () => ({ phase: clock < 5000 ? 'connecting' : 'failed', overlay: 'banner', failed: clock >= 5000 }),
    page: { screenshot: async ({ path }) => { events.push('screenshot'); assert.ok(clock < 5000); assert.match(path, /reconnecting-populated/); } },
    checkControlConsistency: async () => { events.push('controls'); clock += 6000; return { checked: 3, violations: [] }; },
    assertNoControlViolations: result => assert.equal(result.violations.length, 0),
    scope: { evaluate: async () => { events.push('layout'); return { chatWidth: 400, paneWidth: 400, overflow: 0 }; } },
  });
  vm.runInContext(`${declaration('capture')}\nglobalThis.run = capture;`, context);
  await context.run('reconnecting-populated', 'light', 'en', 400);
  assert.deepEqual(events, ['screenshot', 'controls', 'layout']);
  assert.equal(report.screenshots.length, 1);
  assert.equal(report.observations[0].phase, 'connecting');
  assert.equal(report.paneWidths[0].chatWidth, 400);
});
