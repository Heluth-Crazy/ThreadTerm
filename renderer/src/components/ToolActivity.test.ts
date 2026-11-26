import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { ActivityFold, ToolActivity } from './ToolActivity';
import { toolEntriesForItems, type ToolThought } from '../toolActivity';
import { turnSegments } from '../turnSegments';

const zh = (_en: string, chinese: string) => chinese;
const command = (id: string, status: string, data: Record<string, unknown>): ChatPart =>
  ({ type: 'tool', toolId: id, toolName: 'commandExecution', status, data: { type: 'commandExecution', ...data } });
const entries = (...parts: ChatPart[]) => toolEntriesForItems([{ id: 'item', role: 'assistant', turnId: 'turn', createdAt: 'now', parts } as ChatItem]);
const render = (props: Partial<Parameters<typeof ToolActivity>[0]> & { entries: ReturnType<typeof entries> }) =>
  renderToStaticMarkup(createElement(ToolActivity, { active: true, provider: 'codex', copy: zh, ...props }));
const text = (html: string, className: string) => [...html.matchAll(new RegExp(`class="${className}"[^>]*>(.*?)</span></span>`, 'g'))].map(match => match[1]!.replace(/<[^>]+>/g, ''));

// The 2026-11-11 screenshot: a failed command whose last line is code, then `npm run build` with no output yet.
const failed = command('node', 'failed', { command: 'node scripts/report.mjs', exitCode: 1, aggregatedOutput: "SyntaxError\nprocess.stdout.write(JSON.stringify(state) + '\\n')" });
const building = command('build', 'inProgress', { command: 'npm run build' });

test('a running command is the whole headline: no output preview line and no separate failures line', () => {
  const html = render({ entries: entries(failed, building) });
  assert.match(html, /正在运行 npm run build/);
  assert.doesNotMatch(html, /chat-tool-output-preview/, 'the latest-output line is gone (11-18 chat-activity-fold)');
  assert.doesNotMatch(html, /chat-tool-failures/, 'failures are a count in the header, not a second line');
  assert.equal((html.match(/class="chat-tool-failed-count"/g) ?? []).length, 0, 'a running call owns the headline, so no failure badge beside it');
});

test('a finished drawer says once how many calls failed, in the header', () => {
  const html = render({ entries: entries(failed, command('build', 'completed', { command: 'npm run build', exitCode: 0, aggregatedOutput: 'built' })), active: false });
  const labels = [...html.matchAll(/class="chat-tool-failed-count"[^>]*>([^<]*)</g)].map(match => match[1]);
  assert.deepEqual(labels, ['1 项失败']);
  assert.doesNotMatch(html, /chat-tool-output-preview/);
});

test('a search with no matches is not a failure', () => {
  const search = command('rg', 'failed', { command: "rg -n 'playwright|puppeteer' artifacts", exitCode: 1, aggregatedOutput: '', commandActions: [{ type: 'search', command: 'rg -n playwright|puppeteer artifacts' }] });
  const html = render({ entries: entries(search), active: false });
  assert.doesNotMatch(html, /项失败/);
});

test('streaming thinking after the last tool makes the drawer headline say so; thoughts render only when open', () => {
  const tools = entries(command('c1', 'completed', { command: 'ls', exitCode: 0 }));
  const item = (status: string): ChatItem => ({ id: 'r', role: 'assistant', turnId: 'turn', createdAt: 'now', parts: [{ type: 'thinking', text: 'Next I will build.', status }] });
  const thoughts = (status: string): ToolThought[] => [{ id: 'r:parts:0', item: item(status), before: 1 }];
  const renderThought = (thought: ChatItem) => createElement('p', { className: 'thought-body' }, thought.parts[0]!.text);
  const html = render({ entries: tools, thoughts: thoughts('streaming'), renderThought });
  assert.match(html, /chat-tool-spinner/);
  assert.match(html, /思考中…/);
  assert.doesNotMatch(html, /thought-body/, 'a collapsed drawer does not mount thinking bodies');
  assert.doesNotMatch(render({ entries: tools, thoughts: thoughts('completed'), renderThought }), /思考中…/);
  assert.doesNotMatch(render({ entries: tools, thoughts: thoughts('streaming'), renderThought, active: false }), /思考中…/, 'only a live turn is thinking');
});

// ── One fold per output segment (11-18 chat-activity-fold) ──
const foldSteps = (parts: ChatPart[]) => {
  const blocks = turnSegments([{ id: 'item', role: 'assistant', turnId: 'turn', createdAt: 'now', parts }]);
  return blocks.flatMap(block => block.kind === 'fold' ? block.steps : []);
};
const renderFold = (props: Partial<Parameters<typeof ActivityFold>[0]>) =>
  renderToStaticMarkup(createElement(ActivityFold, { steps: [], live: false, provider: 'codex', copy: zh, ...props }));

test('a collapsed live fold spins, names the running step, counts the work and shows the newest note', () => {
  const steps = foldSteps([
    { type: 'thinking', text: 'Look at auth', status: 'complete' },
    { type: 'text', text: 'I will read the file.\nSecond line.', status: 'complete', phase: 'commentary' },
    command('read', 'completed', { command: 'ls' }),
    command('build', 'inProgress', { command: 'npm run build' }),
  ]);
  const html = renderFold({ steps, live: true });
  assert.match(html, /chat-tool-spinner/);
  assert.match(html, /正在运行 npm run build/);
  assert.match(html, /运行 2 条命令/);
  assert.match(html, /chat-fold-note/);
  // The note keeps the whole commentary in the DOM; the CSS ellipsis makes it one visual line.
  assert.match(html, /<span class="chat-fold-note">I will read the file\.[\s\S]*Second line\.<\/span>/);
  assert.match(html, /data-tool-id="read"/, 'tool shells stay in the DOM while the fold is closed (navigation)');
  assert.doesNotMatch(html, /tool-card-body/, 'collapsed folds mount no card bodies');
  assert.equal((html.match(/chat-fold-note/g) ?? []).length, 1, 'at most one note line');
});

test('a settled fold leads with its counts, or with the turn duration when it is the turn\'s only fold', () => {
  const steps = foldSteps([command('read', 'completed', { command: 'ls' }), command('bad', 'failed', { command: 'false', exitCode: 1, aggregatedOutput: 'nope' })]);
  const html = renderFold({ steps });
  assert.doesNotMatch(html, /chat-tool-spinner/);
  assert.match(html, /class="chat-fold-counts is-lead">运行 2 条命令</, 'the counts lead; no 已完成 word');
  assert.doesNotMatch(html, /chat-tool-current-action/);
  assert.doesNotMatch(html, /已完成/);
  assert.match(html, /项失败/);
  assert.doesNotMatch(html, /chat-fold-note/, 'the note line belongs to the live header only');
  assert.doesNotMatch(html, /用时/, 'without a duration the fold names none');
  const timed = renderFold({ steps, durationLabel: '用时 2m 14s' });
  assert.match(timed, /class="chat-tool-current-action"[^>]*>用时 2m 14s</);
  assert.match(timed, /class="chat-fold-counts">· 运行 2 条命令</);
});

test('a failure that a later run of the same command fixed is not reported in red', () => {
  const failing = command('t1', 'failed', { command: 'npm test', exitCode: 1, aggregatedOutput: 'Tests  1 failed | 13 passed (14)' });
  const passing = command('t2', 'completed', { command: 'npm test', exitCode: 0, aggregatedOutput: 'Tests  14 passed (14)' });
  assert.doesNotMatch(renderFold({ steps: foldSteps([failing, passing]) }), /项失败/);
  assert.match(renderFold({ steps: foldSteps([passing, failing]) }), /1 项失败/, 'a failure after the last success is still open');
  const open = renderFold({ steps: foldSteps([failing, passing]) }).replace('<details class="chat-tool-activity chat-fold is-settled"', '<details class="chat-tool-activity chat-fold is-settled" open=""');
  assert.match(open, /class="call-row-reason"[^>]*>Tests {2}1 failed \| 13 passed \(14\)</, 'the failed row itself still says why it failed');
  assert.match(open, /退出码 1/);
});

test('rows read like what the call did: reads and searches in words, no numbers, success unmarked', () => {
  const steps = foldSteps([
    command('s', 'completed', { command: 'pwsh -Command "rg -n saveNote src"', cwd: 'D:\\work', aggregatedOutput: 'src/notes/api.ts:12:export async function saveNote(note) {\nsrc/notes/editor.tsx:88:    await saveNote(draft);',
      commandActions: [{ type: 'search', command: 'rg -n saveNote src', query: 'saveNote', path: 'src' }] }),
    command('r', 'completed', { command: 'pwsh -Command "Get-Content -Raw src/notes/api.ts"', aggregatedOutput: 'x',
      commandActions: [{ type: 'read', command: 'Get-Content -Raw src/notes/api.ts', name: 'api.ts', path: 'D:\\work\\src\\notes\\api.ts' }] }),
    command('t', 'completed', { command: 'npm test', exitCode: 0 }),
  ]);
  const html = renderFold({ steps, sessionCwd: 'D:\\work' });
  assert.match(html, /class="call-row-label" title="[^"]*">搜索 saveNote</);
  assert.match(html, /class="call-row-where" title="src · 2 处">src · 2 处</);
  assert.match(html, /class="call-row-label" title="[^"]*">读取 api\.ts</);
  assert.match(html, /class="call-row-where" title="src\/notes">src\/notes</, 'paths are shown relative to the session folder');
  assert.match(html, /class="call-row-label is-mono" title="npm test">npm test</);
  assert.match(html, /查看 1 个文件 · 搜索 1 次 · 运行 1 条命令/, 'a read or search command is not also counted as a command');
  assert.doesNotMatch(html, /chat-tool-step|tool-card-status|已完成|>pwsh<|>read<|>search</, 'no row numbers, status pills or raw action chips');
});

test('a thought row shows a Codex summary heading without Markdown markers', () => {
  const steps = foldSteps([{ type: 'thinking', text: '**Finding where notes are saved**\n\nI need the save path first.', status: 'complete' }, command('t', 'completed', { command: 'ls' })]);
  const html = renderFold({ steps });
  assert.match(html, /class="chat-fold-step-value is-dim" title="Finding where notes are saved">Finding where notes are saved</);
  assert.doesNotMatch(html, /\*\*/);
});

test('a thinking-only fold reads 思考过程 when settled and the turn outcome otherwise', () => {
  const steps = foldSteps([{ type: 'thinking', text: 'Only a thought', status: 'streaming' }]);
  assert.match(renderFold({ steps, live: true }), /思考中…/);
  assert.match(renderFold({ steps: foldSteps([{ type: 'thinking', text: 'Only a thought', status: 'complete' }]) }), /思考过程/);
  assert.match(renderFold({ steps, outcome: 'failed' }), /失败/);
  assert.match(renderFold({ steps, outcome: 'interrupted' }), /已中断/);
});

test('an expanded fold is one dense row per step, in order, with each item addressable', () => {
  const steps = foldSteps([
    { type: 'thinking', text: 'First thought', status: 'complete' },
    command('cmd-1', 'completed', { command: 'npm test' }),
    { type: 'text', text: 'A note in the middle', status: 'complete', phase: 'commentary' },
    { type: 'approval', approvalId: 'appr', status: 'resolved', data: { approvalId: 'appr', requestType: 'commandExecution', details: { command: 'cargo test --lib auth' }, choices: [] } },
  ]);
  const details = renderFold({ steps }).replace('<details class="chat-tool-activity chat-fold is-settled"', '<details class="chat-tool-activity chat-fold is-settled" open=""');
  const rows = [...details.matchAll(/<(?:div|details) class="chat-fold-step ([^"]*)"/g)].map(match => match[1]!.trim());
  assert.deepEqual(rows, ['is-thinking', 'is-note', 'is-approval is-resolved']);
  assert.match(details, /data-chat-item="item"/, 'steps keep their item address while folded');
  assert.match(details, /已作出决定/, 'a resolved approval is one row');
  assert.match(details, /cargo test --lib auth/);
});

test('a live fold shows how long the turn has run', () => {
  const steps = foldSteps([command('build', 'inProgress', { command: 'npm run build', aggregatedOutput: 'Checking 214 files…' })]);
  const startedAt = new Date(Date.now() - 12_000).toISOString();
  const html = renderFold({ steps, live: true, startedAt });
  assert.match(html, /class="chat-fold-elapsed"[^>]*>1[23]s</);
  assert.match(html, /class="chat-fold-note is-output">Checking 214 files…</, 'the running command\'s newest output is the second line');
  assert.doesNotMatch(renderFold({ steps }), /chat-fold-elapsed/, 'a settled fold has no timer');
});
