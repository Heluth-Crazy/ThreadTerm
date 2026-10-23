import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatPart } from '@threadterm/protocol';
import { approvalPreviewBudget, APPROVAL_PREVIEW_FILE_LIMIT, APPROVAL_PREVIEW_ROW_LIMIT, cardBodyVisible, commandDisplayCwd, compactToolArguments, diffView, editFileStats, isOpenableDiffPath, jsonView, mcpResultView, moreFilesLabel, outputView, toolCardHasBody, toolStatusLabel, DIFF_COLLAPSE_LINES, OUTPUT_MAX_LINES, JSON_NODE_LIMIT } from './toolCards';
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

test('command cwd chips compare native drive, UNC and slash forms', () => {
  assert.equal(commandDisplayCwd('\\\\?\\D:\\Repo\\', 'd:/repo'), undefined);
  assert.equal(commandDisplayCwd('D:/Repo/', '\\\\?\\d:\\repo'), undefined);
  assert.equal(commandDisplayCwd('\\\\?\\UNC\\server\\share\\repo\\', '\\\\server\\share\\repo'), undefined);
  assert.equal(commandDisplayCwd('//?/UNC/server/share/repo/', '\\\\server\\share\\repo'), undefined);
  assert.equal(commandDisplayCwd('D:\\other', 'D:\\repo'), 'D:\\other');
  assert.equal(commandDisplayCwd('D:\\repo', undefined), 'D:\\repo');
  assert.equal(commandDisplayCwd(undefined, 'D:\\repo'), undefined);
  assert.equal(commandDisplayCwd('/Repo', '/repo'), '/Repo', 'POSIX path case is significant');
});

test('small flat MCP arguments render as compact primitive lines', () => {
  assert.deepEqual(compactToolArguments({ session: 'face82d9', count: 4, wait: false, branch: null }), [
    ['session', 'face82d9'], ['count', '4'], ['wait', 'false'], ['branch', 'null'],
  ]);
  assert.deepEqual(compactToolArguments('{"session":"face82d9"}'), [['session', 'face82d9']]);
  assert.deepEqual(compactToolArguments({}), []);
  assert.equal(compactToolArguments({ ids: ['x'] }), undefined);
  assert.equal(compactToolArguments({ args: { wait: true } }), undefined);
  assert.equal(compactToolArguments(Array.from({ length: 2 }, (_, i) => i)), undefined);
  assert.equal(compactToolArguments('plain text'), undefined);
  assert.equal(compactToolArguments(null), undefined);
  assert.ok(compactToolArguments(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i]))));
  assert.equal(compactToolArguments(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))), undefined);
});

test('MCP result envelopes reveal text blocks and format JSON text', () => {
  const value = { content: [{ type: 'text', text: '{"id":"face82d9","status":"idle"}' }, { type: 'image', data: 'bytes' }, { type: 'text', text: '**Exploration**\nFound 21 symbols.' }], structuredContent: { id: 'duplicate' } };
  const original = JSON.stringify(value);
  const result = mcpResultView(value);
  assert.equal(result?.text, '{\n  "id": "face82d9",\n  "status": "idle"\n}\n\n**Exploration**\nFound 21 symbols.');
  assert.equal(result?.isError, false);
  assert.deepEqual(mcpResultView(JSON.stringify(value)), result, 'JSON-string envelopes use the same presentation');
  assert.equal(JSON.stringify(value), original, 'native output is unchanged');
});

test('MCP results preserve structured-only output, errors and ordinary results', () => {
  assert.deepEqual(mcpResultView({ content: [], structuredContent: { count: 2 }, isError: true }), { structuredContent: { count: 2 }, isError: true });
  assert.equal(mcpResultView({ content: [{ type: 'text', text: 'failure reason' }], isError: true })?.isError, true);
  assert.equal(mcpResultView({ content: [{ type: 'text', text: '' }] })?.text, '');
  assert.equal(mcpResultView({ content: [{ type: 'image', data: 'bytes' }] })?.text, undefined);
  assert.equal(mcpResultView({ result: 4 }), undefined);
  assert.equal(mcpResultView('ordinary result'), undefined);
  assert.equal(mcpResultView('[1,2]'), undefined);
  assert.equal(mcpResultView(null), undefined);
});

test('MCP text reuses the bounded output view', () => {
  const text = Array.from({ length: OUTPUT_MAX_LINES + 20 }, (_, i) => `line ${i}`).join('\n');
  const result = mcpResultView({ content: [{ type: 'text', text }] });
  assert.equal(outputView(result?.text, false).expandable, true);
  assert.equal(outputView(result?.text, false).lines.length, 40);
  assert.equal(outputView(result?.text, true).lines.length, OUTPUT_MAX_LINES);
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

test('typed tool cards omit empty command, read, search, and web bodies', () => {
  const command = (data: Record<string, unknown>) => toolView(part({ type: 'commandExecution', command: 'git status', ...data }, 'commandExecution'));
  assert.equal(toolCardHasBody(command({})), false);
  assert.equal(toolCardHasBody(command({ cwd: 'D:\\repo' }), 'd:/repo'), false, 'normalized equal cwd is hidden');
  assert.equal(toolCardHasBody(command({ command: "pwsh -Command 'git status'" })), true);
  assert.equal(toolCardHasBody(command({ cwd: 'D:\\other' }), 'D:\\repo'), true);
  assert.equal(toolCardHasBody(command({ input: { run_in_background: true } })), true);
  assert.equal(toolCardHasBody(command({ exitCode: 1 })), true);
  assert.equal(toolCardHasBody(command({ exitCode: 0 })), false);
  assert.equal(toolCardHasBody(command({ commandActions: [{ type: 'read' }] })), true);
  assert.equal(toolCardHasBody(command({ output: 'clean' })), true);

  const read = (data: unknown) => toolView(part(data, 'Read'));
  assert.equal(toolCardHasBody(read({ input: { path: 'a.ts' } })), false);
  assert.equal(toolCardHasBody(read({ input: { path: 'a.ts', offset: 0 } })), true);
  assert.equal(toolCardHasBody(read({ input: { path: 'a.ts', limit: 0 } })), true);
  assert.equal(toolCardHasBody(read({ input: { path: 'a.ts', pages: 0 } })), true);

  const search = (data: unknown) => toolView(part(data, 'Grep'));
  assert.equal(toolCardHasBody(search({ input: { pattern: 'todo' } })), false);
  assert.equal(toolCardHasBody(search({ input: { pattern: 'todo', path: 'src' } })), true);
  assert.equal(toolCardHasBody(search({ input: { pattern: 'todo', glob: '*.ts' } })), true);
  assert.equal(toolCardHasBody(search({ input: { pattern: 'todo' }, output: '1 match in 1 file' })), true);
  assert.equal(toolCardHasBody(search({ input: { pattern: 'todo', caseInsensitive: true } })), true);
  assert.equal(toolCardHasBody(search({ input: { pattern: 'todo' }, output: 'results omitted' })), true);

  const web = (data: unknown) => toolView(part(data, 'WebSearch'));
  assert.equal(toolCardHasBody(web({ input: { query: 'docs' } })), false);
  assert.equal(toolCardHasBody(web({ input: { query: 'docs' }, output: 'result' })), true);
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

test('toolSummary gives ThreadTerm delegations a first, separate segment', () => {
  const starts = toolSummary([
    entry({ server: 'threadterm', tool: 'delegate_start' }, 'mcpToolCall'),
    entry({ server: 'threadterm', tool: 'delegate_start' }, 'mcpToolCall'),
    entry({ server: 'threadterm', tool: 'delegate_wait' }, 'mcpToolCall'),
    entry({ input: { todos: [] } }, 'TodoWrite'),
  ]);
  assert.deepEqual({ delegates: starts.delegates, followedDelegates: starts.followedDelegates, other: starts.other }, { delegates: 2, followedDelegates: 1, other: 1 });
  assert.deepEqual(toolSummarySegments(starts, copy), ['Started 2 delegates', 'Used 1 tool']);
  assert.equal(toolSummaryLabel(starts, copy), 'Started 2 delegates · Used 1 tool');
  assert.deepEqual(toolSummarySegments(starts, (_en, chinese) => chinese), ['启动 2 个委派', '使用 1 项工具']);

  const followed = toolSummary([entry({ server: 'threadterm', tool: 'delegate_result' }, 'mcpToolCall')]);
  assert.equal(followed.other, 0);
  assert.deepEqual(toolSummarySegments(followed, copy), ['Followed delegates']);
  assert.deepEqual(toolSummarySegments(followed, (_en, chinese) => chinese), ['跟进委派']);

  const outcomes = toolSummary([
    entry({ server: 'threadterm', tool: 'delegate_start' }, 'mcpToolCall', 'failed'),
    entry({ server: 'threadterm', tool: 'delegate_wait' }, 'mcpToolCall', 'cancelled'),
    entry({ server: 'foreign', tool: 'delegate_start' }, 'mcpToolCall'),
  ]);
  assert.deepEqual({ delegates: outcomes.delegates, followedDelegates: outcomes.followedDelegates, other: outcomes.other, failed: outcomes.failed, interrupted: outcomes.interrupted },
    { delegates: 1, followedDelegates: 1, other: 1, failed: 1, interrupted: 1 });
  assert.equal(toolSummaryText(outcomes, copy), 'Started 1 delegate · Used 1 tool · 1 failed · 1 interrupted');
  assert.equal(toolSummaryText(outcomes, (_en, chinese) => chinese), '启动 1 个委派 · 使用 1 项工具 · 1 项失败 · 1 项中断');

  const capped = toolSummary([
    entry({ server: 'threadterm', tool: 'delegate_start' }, 'mcpToolCall'),
    entry({ input: { file_path: 'a.ts' } }, 'Read'),
    entry({ input: { pattern: 'todo' } }, 'Grep'),
    entry({ type: 'commandExecution', command: 'git status' }, 'commandExecution'),
    entry({ type: 'fileChange', changes: [{ path: 'a.ts', kind: { type: 'update' } }] }, 'fileChange'),
    entry({ input: { todos: [] } }, 'TodoWrite'),
  ]);
  assert.deepEqual(toolSummarySegments(capped, copy), ['Started 1 delegate', 'Explored 1 file', 'Searched 1', 'Ran 1 command', '+2 more']);
});

test('a command with no actions is only a command', () => {
  const view = toolView(part({ id: 'c', type: 'commandExecution', command: 'npm run lint' }, 'commandExecution'));
  assert.equal(view.kind, 'command');
  const summary = toolSummary([{ id: 'e', itemId: 'i', part: part({ id: 'c', type: 'commandExecution', command: 'npm run lint' }, 'commandExecution') }]);
  assert.deepEqual({ explored: summary.explored, searched: summary.searched, ran: summary.ran }, { explored: 0, searched: 0, ran: 1 });
});
