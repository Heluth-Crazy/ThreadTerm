import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createRequire } from 'node:module';
Object.assign(globalThis, { require: createRequire(import.meta.url) });
const { renderToStaticMarkup } = await import('react-dom/server');
import type { ChatItem, ChatPart } from '@threadterm/protocol';
import { ToolActivity } from './ToolActivity';
import { toolEntriesForItems, type ToolThought } from '../toolActivity';

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

test('a running command shows two lines at most and never another command\'s output', () => {
  const html = render({ entries: entries(failed, building) });
  assert.match(html, /正在执行命令: npm run build/);
  assert.doesNotMatch(html, /chat-tool-output-preview/, 'no "Latest output" borrowed from the failed command');
  assert.doesNotMatch(html, /chat-tool-failures/, 'failures wait until nothing is running');
  const withOutput = render({ entries: entries(failed, command('build', 'inProgress', { command: 'npm run build', aggregatedOutput: 'vite v6 building for production...' })) });
  assert.deepEqual(text(withOutput, 'chat-tool-output-preview'), ['最新输出vite v6 building for production...']);
  assert.doesNotMatch(withOutput, /chat-tool-failures/);
});

test('a finished drawer shows its failures once and no output preview', () => {
  const html = render({ entries: entries(failed, command('build', 'completed', { command: 'npm run build', exitCode: 0, aggregatedOutput: 'built' })), active: false });
  assert.equal((html.match(/chat-tool-failures/g) ?? []).length, 1);
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
