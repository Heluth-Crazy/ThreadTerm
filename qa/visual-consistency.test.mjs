// Unit tests for the shared visual-consistency helper (issue VC, step V1).
// Run with the QA-helper suite: node runtime/target-qa/run-qa-tests.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  analyzeControls,
  compareGroup,
  checkControlConsistency,
  collectControlsInPage,
  disabledHoverChanged,
  disabledRowHoverChanged,
  groupControls,
  tokenLintDiff,
} from './lib/visual-consistency.mjs';
import { sendChatPrompt } from './lib/chat-send.mjs';
import { installVisualFixture } from './parity/fixture.mjs';

test('visual fixture reports no worktree setup runs for idle projects', async () => {
  const window = {};
  const seed = { store: { recentSessionIds: [], followed: [], bookmarks: [] }, projects: {}, sessions: [], trees: {
    'orbit-checkout': { id: 'orbit-checkout', path: 'D:/fixture/checkout' },
    'orbit-hotfix': { id: 'orbit-hotfix', path: 'D:/fixture/hotfix' },
  } };
  runInNewContext(`(${installVisualFixture.toString()})({seed,theme:'light'})`, {
    window, seed, URLSearchParams, structuredClone, location: { search: '?lang=en' }, localStorage: { setItem() {} },
  });
  for (const projectId of ['orbit', 'missing-project']) {
    const result = await window.threadterm.request('quickLaunch.setup.status', { projectId });
    assert.ok(Array.isArray(result), 'protocol requires WorktreeSetupRun[]');
    assert.equal(result.length, 0, 'no setup run is fabricated for an idle fixture');
  }
  assert.equal(window.__parityFixture.calls.filter(call => call.method === 'quickLaunch.setup.status').length, 2);
  assert.equal((await window.threadterm.request('runtime.snapshot', {})).revision, 1, 'status reads do not mutate state');
});

const control = (overrides = {}) => ({
  selector: 'button.btn',
  parentKey: 0,
  parentPath: 'div.row',
  disabled: false,
  iconOnly: false,
  top: 0,
  bottom: 26,
  centerY: 13,
  height: 26,
  fontSize: 12,
  borderRadius: 6,
  paddingLeft: 10,
  paddingRight: 10,
  borderTopWidth: 1,
  focusVisibleOutline: 2,
  ...overrides,
});

test('groupControls keeps side-by-side controls in one row', () => {
  const controls = [
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 1, bottom: 27, centerY: 14 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].controls.length, 2);
});

test('groupControls splits vertically stacked controls into separate rows', () => {
  const controls = [
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 40, bottom: 66, centerY: 53 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 2);
});

test('groupControls groups overlapping controls even when their parents differ', () => {
  const controls = [
    control({ selector: 'button.a', parentKey: 0, parentPath: 'div.a' }),
    control({ selector: 'button.b', parentKey: 1, parentPath: 'div.b', top: 1, bottom: 27, centerY: 14 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].controls.length, 2);
});

test('groupControls merges a taller control that overlaps a neighbour band', () => {
  const controls = [
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 10, bottom: 50, centerY: 30, height: 40 }),
  ];
  const groups = groupControls(controls);
  assert.equal(groups.length, 1);
});

test('groupControls compares a floating control with its overlapping card row', () => {
  const groups = groupControls([
    control({ selector: 'button.card-action' }),
    control({ selector: 'button.floating-action', floating: true, parentKey: 1, parentPath: 'div.overlay', top: 1, bottom: 27, centerY: 14 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].controls.length, 2);
});

test('analyzeControls reports a mismatched floating control beside a card action', () => {
  const violations = analyzeControls([
    control({ selector: 'button.card-action' }),
    control({ selector: 'button.floating-action', floating: true, parentKey: 1, parentPath: 'div.overlay', top: 1, bottom: 31, centerY: 16, height: 30 }),
  ]);
  const height = violations.find(violation => violation.kind === 'height');
  assert.ok(height, 'the floating control is compared to the overlapping card action');
  assert.deepEqual(height.controls, ['button.card-action', 'button.floating-action']);
});

test('analyzeControls compares mismatched floating controls in one overlay band', () => {
  const violations = analyzeControls([
    control({ selector: 'button.floating-a', floating: true, parentPath: 'div.overlay', height: 26 }),
    control({ selector: 'button.floating-b', floating: true, parentPath: 'div.overlay', top: 1, bottom: 31, centerY: 16, height: 30 }),
  ]);
  assert.ok(violations.some(violation => violation.kind === 'height'));
});

test('groupControls keeps an unrelated floating overlay in a separate band', () => {
  const groups = groupControls([
    control({ selector: 'button.card-action' }),
    control({ selector: 'button.floating-overlay', floating: true, top: 80, bottom: 106, centerY: 93 }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].controls.length, 1);
});

test('compareGroup reports a height mismatch with both values', () => {
  const group = groupControls([
    control({ selector: 'button.a', height: 26, bottom: 26 }),
    control({ selector: 'button.b', height: 30, bottom: 30 }),
  ])[0];
  const violations = compareGroup(group);
  const height = violations.find(violation => violation.kind === 'height');
  assert.ok(height, 'a height violation is reported');
  assert.deepEqual(height.values, [26, 30]);
  assert.equal(height.controls.length, 2);
});

test('compareGroup reports a vertical-centre drift', () => {
  const group = groupControls([
    control({ selector: 'button.a', top: 0, bottom: 26, centerY: 13 }),
    control({ selector: 'button.b', top: 5, bottom: 31, centerY: 18 }),
  ])[0];
  const violations = compareGroup(group);
  assert.ok(violations.some(violation => violation.kind === 'vertical-centre'));
});

test('compareGroup compares padding only inside the same control variant', () => {
  const textGroup = groupControls([
    control({ selector: 'button.a', paddingLeft: 10, paddingRight: 10 }),
    control({ selector: 'button.b', paddingLeft: 12, paddingRight: 12 }),
  ])[0];
  assert.ok(compareGroup(textGroup).some(violation => violation.kind === 'padding'));

  const mixedGroup = groupControls([
    control({ selector: 'button.text', height: 26, bottom: 26, paddingLeft: 10, paddingRight: 10 }),
    control({ selector: 'button.icon', height: 26, bottom: 26, iconOnly: true, paddingLeft: 0, paddingRight: 0 }),
  ])[0];
  const mixed = compareGroup(mixedGroup);
  assert.equal(mixed.some(violation => violation.kind === 'padding'), false, 'icon and text controls are not compared on padding');
  assert.equal(mixed.some(violation => violation.kind === 'height'), false);
});

test('compareGroup reports the radius mismatch of a row', () => {
  const group = groupControls([
    control({ selector: 'button.a', borderRadius: 6 }),
    control({ selector: 'span.chip', borderRadius: 999 }),
  ])[0];
  assert.ok(compareGroup(group).some(violation => violation.kind === 'border-radius'));
});

test('analyzeControls flags a control with a zero focus-visible outline', () => {
  const violations = analyzeControls([
    control({ selector: 'button.a', focusVisibleOutline: 0 }),
    control({ selector: 'button.b', focusVisibleOutline: 2 }),
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'focus-visible');
  assert.equal(violations[0].controls[0], 'button.a');
});

test('tokenLintDiff flags added hex and rgb literals', () => {
  const diff = [
    'diff --git a/renderer/src/styles.css b/renderer/src/styles.css',
    '--- a/renderer/src/styles.css',
    '+++ b/renderer/src/styles.css',
    '@@ -1,0 +2,2 @@',
    '+.a { color: #fff; }',
    '+.b { box-shadow: 0 1px 4px rgba(0,0,0,.14); }',
    '-.old { color: #000; }',
    ' .context { color: #123456; }',
    '+.c { background: color-mix(in srgb, var(--primary) 12%, transparent); }',
    '+.d { color: var(--text); }',
  ].join('\n');
  const { violations } = tokenLintDiff(diff);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map(violation => violation.file), ['renderer/src/styles.css', 'renderer/src/styles.css']);
  assert.deepEqual(violations[0].matches, ['#fff']);
  assert.deepEqual(violations[1].matches, ['rgba(']);
});

test('tokenLintDiff ignores removed and context lines', () => {
  const diff = '+++ b/foo.css\n@@ -1 +1 @@\n-.x { color: #fff; }\n .y { color: #000; }\n+.z { color: var(--text); }';
  assert.deepEqual(tokenLintDiff(diff).violations, []);
});

test('this task adds no new colour literals to CSS', () => {
  const repo = resolve(import.meta.dirname, '..');
  const diff = execFileSync('git', ['diff', '846c272', '--', '*.css'], { cwd: repo, encoding: 'utf8' });
  const { violations } = tokenLintDiff(diff);
  assert.deepEqual(
    violations,
    [],
    `new CSS colour literals since 846c272:\n${violations.map(violation => `${violation.file}:${violation.line} ${violation.content}`).join('\n')}`,
  );
});

test('a disabled control that changes on hover while still disabled is a violation', () => {
  assert.equal(disabledHoverChanged(
    { backgroundColor: 'rgb(1,1,1)', color: 'rgb(2,2,2)', borderTopColor: 'rgb(3,3,3)', opacity: '1', disabled: true },
    { backgroundColor: 'rgb(9,9,9)', color: 'rgb(2,2,2)', borderTopColor: 'rgb(3,3,3)', opacity: '1', disabled: true },
  ), true);
});

test('a control that becomes enabled during the probe is skipped, not reported', () => {
  assert.equal(disabledHoverChanged(
    { backgroundColor: 'rgb(1,1,1)', color: 'rgb(2,2,2)', borderTopColor: 'rgb(3,3,3)', opacity: '0.5', disabled: true },
    { backgroundColor: 'rgb(9,9,9)', color: 'rgb(2,2,2)', borderTopColor: 'rgb(3,3,3)', opacity: '1', disabled: false },
  ), false);
  assert.equal(disabledHoverChanged(
    { backgroundColor: 'rgb(1,1,1)', color: 'rgb(2,2,2)', borderTopColor: 'rgb(3,3,3)', opacity: '0.5', disabled: true },
    null,
  ), false);
});

const stateControl = overrides => control({
  on: false, stateVariant: 'btn btn-sm', backgroundColor: 'surface', color: 'text', borderColor: 'border', boxShadow: 'none', ...overrides,
});

test('selected-state comparisons are off by default and opt in to identical siblings', () => {
  const controls = [stateControl({ selector: 'button.on', on: true }), stateControl({ selector: 'button.off' })];
  assert.deepEqual(analyzeControls(controls), []);
  const violations = analyzeControls(controls, { checkStates: true });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'state');
  assert.deepEqual(violations[0].controls, ['button.on', 'button.off']);
});

test('each supported paint difference makes a selected sibling distinguishable', () => {
  for (const property of ['backgroundColor', 'color', 'borderColor', 'boxShadow']) {
    assert.deepEqual(analyzeControls([
      stateControl({ on: true, [property]: 'selected' }), stateControl(),
    ], { checkStates: true }), [], property);
  }
});

test('state comparisons stay within a row, parent, variant and enabled state', () => {
  const on = stateControl({ on: true });
  for (const off of [
    stateControl({ top: 40, bottom: 66, centerY: 53 }),
    stateControl({ parentKey: 1 }),
    stateControl({ stateVariant: 'btn btn-primary' }),
    stateControl({ iconOnly: true }),
    stateControl({ disabled: true }),
  ]) assert.equal(analyzeControls([on, off], { checkStates: true }).some(item => item.kind === 'state'), false);
  assert.deepEqual(analyzeControls([on, stateControl({ on: true })], { checkStates: true }), []);
});

test('a selected control must differ from every comparable off sibling', () => {
  const violations = analyzeControls([
    stateControl({ selector: 'button.on', on: true }),
    stateControl({ selector: 'button.distinct', color: 'different' }),
    stateControl({ selector: 'button.identical' }),
  ], { checkStates: true });
  assert.deepEqual(violations[0].controls, ['button.on', 'button.identical']);
});

test('collector recognizes all selected markers only when opted in', () => {
  const parent = { tagName: 'DIV', className: 'row' };
  const style = { display: 'block', visibility: 'visible', position: 'static', fontSize: '12px', borderTopLeftRadius: '6px', paddingLeft: '10px', paddingRight: '10px', borderTopWidth: '1px', backgroundColor: 'surface', color: 'text', borderColor: 'border', boxShadow: 'none' };
  const element = marker => ({
    tagName: 'BUTTON', className: marker === 'is-on' ? 'btn btn-sm is-on' : 'btn btn-sm',
    classList: Object.assign(['btn', 'btn-sm', ...(marker === 'is-on' ? ['is-on'] : [])], { contains: name => marker === name }),
    parentElement: parent, textContent: 'Choice', hidden: false,
    getAttribute: name => name === marker ? 'true' : null,
    closest: () => null, matches: () => false,
    getBoundingClientRect: () => ({ width: 80, height: 26, top: 0, bottom: 26, left: 0, right: 80 }),
  });
  const savedDocument = globalThis.document, savedWindow = globalThis.window;
  const all = ['aria-pressed', 'aria-expanded', 'aria-checked', 'is-on', 'off'].map(element);
  try {
    globalThis.document = { body: { querySelectorAll: () => all } };
    globalThis.window = { getComputedStyle: () => style };
    assert.equal(collectControlsInPage({}).controls.some(item => 'on' in item), false);
    const collected = collectControlsInPage({ checkStates: true }).controls;
    assert.deepEqual(collected.map(item => item.on), [true, true, true, true, false]);
    assert.ok(collected.every(item => item.stateVariant === 'btn btn-sm'));
    assert.ok(collected.every(item => item.borderColor === 'border' && item.boxShadow === 'none'));
  } finally {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  }
});

test('disabled input rows report only background changes while still disabled', () => {
  const before = { disabled: true, backgroundColor: 'surface', color: 'text' };
  assert.equal(disabledRowHoverChanged(before, { ...before, backgroundColor: 'hover' }), true);
  assert.equal(disabledRowHoverChanged(before, { ...before, color: 'other' }), false);
  assert.equal(disabledRowHoverChanged(before, { disabled: false, backgroundColor: 'hover' }), false);
  assert.equal(disabledRowHoverChanged(before, null), false);
});

test('collector adds visible disabled labels and option rows only when opted in', () => {
  const savedDocument = globalThis.document, savedWindow = globalThis.window;
  const parent = { tagName: 'DIV', className: 'options' };
  const row = (tagName, disabled, hidden = false) => ({
    tagName, className: 'option-row', parentElement: parent, hidden,
    querySelector: selector => selector === 'input:disabled' && disabled ? {} : null,
    closest: () => null, getAttribute: () => null,
    setAttribute: (name, value) => { probes.push([name, value]); },
    getBoundingClientRect: () => ({ width: 80, height: 26, top: 0, bottom: 26, left: 0, right: 80 }),
  });
  const probes = [];
  const rows = [row('LABEL', true), row('DIV', true), row('LABEL', false), row('LABEL', true, true)];
  try {
    globalThis.document = { body: { querySelectorAll: selector => selector.startsWith('label,') ? rows : [] } };
    globalThis.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    assert.equal(collectControlsInPage({}).disabledRows, undefined);
    assert.deepEqual(probes, []);
    const collected = collectControlsInPage({ checkDisabledRows: true });
    assert.equal(collected.disabledRows.length, 2);
    assert.deepEqual(probes, [['data-vc-probe', '0'], ['data-vc-probe', '1']]);
    assert.ok(collected.disabledRows.every(item => item.hoverOnly));
    assert.deepEqual(collected.controls, [], 'input rows do not enter button geometry comparisons');
  } finally {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  }
});

test('page helper keeps defaults off and uses the existing probe loop for opted-in disabled rows', async () => {
  for (const enabled of [false, true]) {
    let hovered = false, cleaned = false, hoveredRow = false;
    const page = {
      mouse: { move: async () => { hovered = false; } },
      evaluate: async (fn, options) => {
        if (!options) { cleaned = true; return; }
        assert.equal(options.checkStates, enabled);
        assert.equal(options.checkDisabledRows, enabled);
        return { controls: [], ...(enabled ? { disabledRows: [{ probe: '0', selector: 'label.option', parentPath: 'div.options', hoverOnly: true }] } : {}) };
      },
      locator: selector => {
        assert.equal(selector, '[data-vc-probe="0"]');
        return {
          hover: async () => { hovered = true; hoveredRow = true; },
          evaluate: async (_fn, isRow) => isRow === undefined ? undefined : ({ disabled: true, backgroundColor: hovered ? 'hover' : 'surface' }),
        };
      },
    };
    const result = await checkControlConsistency(page, '.options', enabled ? { checkStates: true, checkDisabledRows: true } : {});
    assert.equal(hoveredRow, enabled);
    assert.equal(cleaned, enabled);
    assert.equal(result.violations.length, enabled ? 1 : 0);
    if (enabled) { assert.equal(result.violations[0].kind, 'disabled-hover'); assert.equal(result.disabledRowsChecked, 1); }
    else assert.equal('disabledRowsChecked' in result, false);
  }
});

function sendHarness(onClick) {
  const state = { value: '', clicks: 0, committed: false, items: [{ id: 'old-user', role: 'user' }], diagnostics: [] };
  const options = {
    text: 'New prompt', turnStartTimeout: 0, readyTimeout: 0, pollInterval: 0,
    composer: {
      fill: async text => { state.value = text; },
      evaluate: async () => { state.committed = true; },
      inputValue: async () => state.value,
      isEnabled: async () => true,
    },
    sendButton: { isEnabled: async () => state.committed, click: async () => { state.clicks += 1; await onClick(state); } },
    readSnapshot: async () => ({ items: [...state.items] }),
    readConnection: async () => ({ phase: 'ready' }),
    onDiagnostic: async value => { state.diagnostics.push(value); },
  };
  return { state, options };
}

test('send waits for committed input and confirms composer clearing without a retry', async () => {
  const { state, options } = sendHarness(current => { assert.equal(current.committed, true); current.value = ''; });
  await sendChatPrompt(options);
  assert.equal(state.clicks, 1);
  assert.deepEqual(state.diagnostics, []);
});

test('send accepts a newly projected user item even if the composer is not cleared yet', async () => {
  const { state, options } = sendHarness(current => { current.items.push({ id: 'new-user', role: 'user' }); });
  await sendChatPrompt(options);
  assert.equal(state.clicks, 1);
});

test('send records diagnostics and retries once when the first click did not submit', async () => {
  const { state, options } = sendHarness(current => { if (current.clicks === 2) current.value = ''; });
  await sendChatPrompt(options);
  assert.equal(state.clicks, 2);
  assert.equal(state.diagnostics.length, 1);
  assert.deepEqual(state.diagnostics[0], { attempt: 1, clickError: undefined, value: 'New prompt', buttonDisabled: false, composerDisabled: false, connection: { phase: 'ready' } });
});

test('old user items do not hide a failed send, which fails after exactly two attempts', async () => {
  const { state, options } = sendHarness(() => {});
  await assert.rejects(sendChatPrompt(options), /did not start after two submit attempts/);
  assert.equal(state.clicks, 2);
  assert.equal(state.diagnostics.length, 2);
});

test('send does not duplicate a turn that starts late before the retry', async () => {
  const { state, options } = sendHarness(() => {});
  options.onDiagnostic = async diagnostic => { state.diagnostics.push(diagnostic); state.items.push({ id: 'late-user', role: 'user' }); };
  await sendChatPrompt(options);
  assert.equal(state.clicks, 1);
});

test('send rejects a disabled submit or a changed draft instead of forcing submission', async () => {
  for (const reason of ['disabled', 'changed']) {
    const { state, options } = sendHarness(() => {});
    if (reason === 'disabled') options.sendButton.isEnabled = async () => false;
    else options.composer.evaluate = async () => { state.committed = true; state.value = 'Changed prompt'; };
    await assert.rejects(sendChatPrompt(options), /Chat send not ready/);
    assert.equal(state.clicks, 0);
  }
});
