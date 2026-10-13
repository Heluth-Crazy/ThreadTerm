import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatPart } from '@threadterm/protocol';
import { approvalPreviewBudget, APPROVAL_PREVIEW_FILE_LIMIT, APPROVAL_PREVIEW_ROW_LIMIT, cardBodyVisible, diffView, editFileStats, isOpenableDiffPath, jsonView, moreFilesLabel, outputView, toolStatusLabel, DIFF_COLLAPSE_LINES, OUTPUT_MAX_LINES, JSON_NODE_LIMIT } from './toolCards';
import { toolSummary, toolSummaryLabel, toolSummarySegments, toolSummaryText } from './toolActivity';
import { toolView } from './toolView';

const copy = (en: string) => en;
const part = (data: unknown, toolName = 'Bash', status = 'completed'): ChatPart => ({ type: 'tool', toolId: String((data as { id?: string })?.id ?? 'x'), toolName, status, data } as ChatPart);
const entry = (data: unknown, toolName?: string, status?: string) => ({ id: `e-${Math.random()}`, itemId: 'i', part: part(data, toolName, status) });

test('unified diffs keep add/remove counts and cap the inline body', () => {
  const view = diffView({ unified: '@@ -1,3 +1,3 @@\n-const version = 1;\n+const version = 2;\n export const app = version;\n' });
  assert.deepEqual(view.stats, { added: 1, removed: 1 });
  assert.equal(view.visible.length, 4);
  assert.equal(view.collapsed, false);
  assert.equal(view.canShowAll, false);
  assert.equal(view.openOnly, false);
  assert.deepEqual(view.rows.map(row => row.kind), ['hunk', 'del', 'add', 'ctx']);
});

test('old/new text diffs render as removed then added lines', () => {
  const view = diffView({ oldText: 'a\nb\nc', newText: 'a\nB\nc' });
  assert.deepEqual(view.rows.map(row => row.kind), ['del', 'add']);
  assert.deepEqual(view.stats, { added: 1, removed: 1 });
  assert.deepEqual(editFileStats({ path: 'a.ts', change: 'modify', diff: { oldText: 'a', newText: 'a\nb' } }), { added: 1, removed: 0 });
});

test('long diffs collapse to 200 lines, then only Open diff past 2,000', () => {
  const long = diffView({ unified: Array.from({ length: DIFF_COLLAPSE_LINES + 5 }, (_, index) => `+line ${index}`).join('\n') });
  assert.equal(long.visible.length, DIFF_COLLAPSE_LINES);
  assert.equal(long.collapsed, true);
  assert.equal(long.canShowAll, true);
  const huge = diffView({ unified: Array.from({ length: 2_050 }, (_, index) => `+line ${index}`).join('\n') });
  assert.equal(huge.canShowAll, false);
  assert.equal(huge.openOnly, true);
  assert.equal(moreFilesLabel(3, 7), '+4');
  assert.equal(moreFilesLabel(3, 3), undefined);
});

test('expanded approval previews cap their total files and rows', () => {
  const files = Array.from({ length: 20 }, (_, index) => ({ path: `src/${index}.ts`, change: 'modify' as const, diff: { unified: Array.from({ length: 200 }, (_, row) => `+${row}`).join('\n') } }));
  const budget = approvalPreviewBudget(files, true);
  assert.equal(budget.files, APPROVAL_PREVIEW_FILE_LIMIT);
  assert.ok(budget.rows.reduce((total, rows) => total + rows, 0) <= APPROVAL_PREVIEW_ROW_LIMIT);
  assert.ok(budget.omittedFiles > 0);
  assert.ok(budget.omittedRows > 0);
});

test('output caps at 400 lines and offers the tail while collapsed', () => {
  const short = outputView('one\ntwo', false);
  assert.deepEqual(short.lines, ['one', 'two']);
  assert.equal(short.expandable, false);
  const long = outputView(Array.from({ length: OUTPUT_MAX_LINES + 50 }, (_, index) => `line ${index}`).join('\n'), false);
  assert.equal(long.total, OUTPUT_MAX_LINES + 50);
  assert.equal(long.lines.length, 40);
  assert.equal(long.omitted, OUTPUT_MAX_LINES + 10);
  assert.equal(long.expandable, true);
  const expanded = outputView(Array.from({ length: OUTPUT_MAX_LINES + 50 }, (_, index) => `line ${index}`).join('\n'), true);
  assert.equal(expanded.lines.length, OUTPUT_MAX_LINES);
  assert.equal(expanded.omitted, 50);
  assert.equal(expanded.expandable, false);
});

test('JSON trees start collapsed beyond depth 2 and cap at 500 nodes', () => {
  const value = { a: { b: { c: { d: 1 } } }, list: [1, 2, 3] };
  const base = jsonView(value);
  assert.deepEqual(base.rows.map(row => [row.path, row.expanded]), [['$', true], ['$.a', true], ['$.a.b', false], ['$.list', true], ['$.list.0', false], ['$.list.1', false], ['$.list.2', false]]);
  const opened = jsonView(value, new Set(['$.a.b']));
  assert.ok(opened.rows.some(row => row.path === '$.a.b.c'));
  const wide = jsonView(Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`k${index}`, index])));
  assert.equal(wide.truncated, true);
  assert.ok(wide.nodes <= JSON_NODE_LIMIT);
});

test('JSON tree paths stay distinct for keys that contain a dot', () => {
  const view = jsonView({ 'a.b': 1, a: { b: 2 } });
  const paths = view.rows.map(row => row.path);
  assert.equal(new Set(paths).size, paths.length, 'every row path is unique');
  assert.ok(paths.includes('$["a.b"]'));
  assert.ok(paths.includes('$.a.b'));
});

test('card bodies are only built for an open drawer', () => {
  assert.equal(cardBodyVisible(false), false);
  assert.equal(cardBodyVisible(true), true);
});

test('Open diff is only offered for a path the diff surface can open', () => {
  assert.equal(isOpenableDiffPath('src/app.ts', 'D:\\repo'), true, 'relative paths are workspace-relative');
  assert.equal(isOpenableDiffPath('D:\\repo\\src\\app.ts', 'D:\\repo'), true, 'absolute path inside the root');
  assert.equal(isOpenableDiffPath('D:\\other\\app.ts', 'D:\\repo'), false, 'absolute path outside the root');
  assert.equal(isOpenableDiffPath('D:\\other\\app.ts', undefined), false, 'absolute path with no known root');
  assert.equal(isOpenableDiffPath('', 'D:\\repo'), false);
  assert.equal(isOpenableDiffPath(undefined, 'D:\\repo'), false);
});

test('status chips stay neutral with a distinct label per state', () => {
  assert.deepEqual(toolStatusLabel('running', true, false, copy), { key: 'running', label: 'Running' });
  assert.deepEqual(toolStatusLabel('running', true, true, copy), { key: 'awaiting', label: 'Awaiting approval' });
  assert.deepEqual(toolStatusLabel('running', false, false, copy), { key: 'inactive', label: 'Inactive' });
  assert.deepEqual(toolStatusLabel('failed', true, false, copy), { key: 'failed', label: 'Failed' });
  assert.deepEqual(toolStatusLabel('cancelled', true, false, copy), { key: 'cancelled', label: 'Interrupted' });
});

test('JSON disclosures can collapse default-open roots and reopen nested nodes', () => {
  const value = { args: { nested: { answer: 42 } } };
  assert.equal(jsonView(value).rows[0]?.expanded, true);
  assert.deepEqual(jsonView(value, new Set(), new Set(['$'])).rows.map(row => row.path), ['$']);
  assert.equal(jsonView(value, new Set(), new Set(['$.args'])).rows.some(row => row.path === '$.args.nested'), false);
  assert.equal(jsonView(value, new Set(['$.args.nested'])).rows.some(row => row.path === '$.args.nested.answer'), true);
});

test('toolSummary counts by kind, distinct edited files and failures', () => {
  const summary = toolSummary([
    entry({ id: 'read', input: { file_path: 'src/a.ts' } }, 'Read'),
    entry({ id: 'grep', input: { pattern: 'foo' } }, 'Grep'),
    entry({ id: 'web', input: { query: 'docs' } }, 'WebSearch'),
    entry({ id: 'cmd-read', type: 'commandExecution', command: 'cat a', commandActions: [{ type: 'read' }, { type: 'listFiles' }] }, 'commandExecution'),
    entry({ id: 'cmd-search', type: 'commandExecution', command: 'rg foo', commandActions: [{ type: 'search' }] }, 'commandExecution'),
    entry({ id: 'edit1', type: 'fileChange', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }] }, 'fileChange'),
    entry({ id: 'edit2', type: 'fileChange', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }, { path: 'src/b.ts', kind: { type: 'add' }, diff: '+x' }] }, 'fileChange'),
    entry({ id: 'todo', input: { todos: [{ content: 'x', status: 'pending' }] } }, 'TodoWrite'),
    entry({ id: 'bad', input: { command: 'false' }, isError: true }, 'Bash', 'failed'),
    entry({ id: 'stop', input: { command: 'sleep' }, status: 'cancelled' }, 'Bash', 'cancelled'),
  ]);
  assert.equal(summary.explored, 2, 'read + one command read/list');
  assert.equal(summary.searched, 3, 'grep + web + one command search');
  assert.equal(summary.ran, 4);
  assert.equal(summary.edited, 2, 'src/a.ts is only counted once');
  assert.equal(summary.other, 1, 'todo');
  assert.equal(summary.failed, 1);
  assert.equal(summary.interrupted, 1);
  const segments = toolSummarySegments(summary, copy);
  assert.equal(segments.length, 5, 'five categories with a positive count');
  assert.equal(segments.at(-1), '+1 more');
  assert.deepEqual(toolSummarySegments(toolSummary([entry({ id: 'r', input: { file_path: 'a' } }, 'Read')]), copy), ['Explored 1 file']);
  assert.equal(toolSummaryText(summary, copy).includes('1 failed'), true);
  assert.equal(toolSummaryText(summary, copy).includes('1 interrupted'), true);
  // The visible label omits the failed/interrupted tail because the drawer shows
  // those as their own red badge; the full sentence stays in the title.
  assert.equal(toolSummaryLabel(summary, copy), toolSummarySegments(summary, copy).join(' · '));
  assert.equal(toolSummaryLabel(summary, copy).includes('failed'), false);
});

test('a command with no actions is only a command', () => {
  const view = toolView(part({ id: 'c', type: 'commandExecution', command: 'npm run lint' }, 'commandExecution'));
  assert.equal(view.kind, 'command');
  const summary = toolSummary([{ id: 'e', itemId: 'i', part: part({ id: 'c', type: 'commandExecution', command: 'npm run lint' }, 'commandExecution') }]);
  assert.deepEqual({ explored: summary.explored, searched: summary.searched, ran: summary.ran }, { explored: 0, searched: 0, ran: 1 });
});
