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
  assert.match(html, /正在执行命令: npm run build/);
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
  assert.match(html, /正在执行命令: npm run build/);
  assert.match(html, /运行 2 条命令/);
  assert.match(html, /chat-fold-note/);
  // The note keeps the whole commentary in the DOM; the CSS ellipsis makes it one visual line.
  assert.match(html, /<span class="chat-fold-note">I will read the file\.[\s\S]*Second line\.<\/span>/);
  assert.match(html, /data-tool-id="read"/, 'tool shells stay in the DOM while the fold is closed (navigation)');
  assert.doesNotMatch(html, /tool-card-body/, 'collapsed folds mount no card bodies');
  assert.equal((html.match(/chat-fold-note/g) ?? []).length, 1, 'at most one note line');
});

test('a settled fold says it is done with the counts and no duration', () => {
  const steps = foldSteps([command('read', 'completed', { command: 'ls' }), command('bad', 'failed', { command: 'false', exitCode: 1, aggregatedOutput: 'nope' })]);
  const html = renderFold({ steps });
  assert.doesNotMatch(html, /chat-tool-spinner/);
  assert.match(html, /已完成/);
  assert.match(html, /项失败/);
  assert.doesNotMatch(html, /chat-fold-note/, 'the note line belongs to the live header only');
  assert.doesNotMatch(html, /秒|用时|\bs\b/, 'the duration lives only in TurnFooter');
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
