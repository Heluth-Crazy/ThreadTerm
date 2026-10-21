import type { ChatItem, ChatPart, Session, SessionDocument } from '@threadterm/protocol';

export interface TaskMapFixture {
  rootSessionId: string;
  sessions: Session[];
  items: Map<string, ChatItem[]>;
  documents: SessionDocument[];
}

export type TaskMapFixtureName = 'delegation' | 'single' | 'empty' | 'long' | 'running' | 'nested' | 'parallel';

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 21, 12) + seconds * 1_000).toISOString();
const titles: Record<string, string> = {
  root: 'Harden workspace validation', claude: 'Inspect validation callers', grok: 'Check provider error paths',
  kimi: 'Review protocol contracts', 'live-child': 'Monitor verification run',
};
const session = (id: string, provider: Session['provider'], seconds = 0, parent?: string): Session => ({
  id, provider, title: titles[id] ?? 'Investigate validation behavior', mode: 'chat', projectId: 'task-map-project', status: 'idle',
  createdAt: at(seconds), updatedAt: at(seconds + 40),
  ...(parent ? { delegation: { id: `delegation-${id}`, parentSessionId: parent, workspace: 'shared', state: 'completed' } } : {}),
});
const item = (id: string, seconds: number, turnId: string, role: ChatItem['role'], parts: ChatPart[], extra: Partial<ChatItem> = {}): ChatItem => ({
  id, role, parts, turnId, createdAt: at(seconds), ...extra,
});
const text = (value: string, phase?: 'commentary' | 'final_answer'): ChatPart => ({ type: 'text', text: value, ...(phase ? { phase } : {}) });
const read = (path: string): ChatPart => ({ type: 'tool', toolName: 'Read', status: 'completed', data: { input: { file_path: path }, result: 'export const value = 1;' } });
const command = (value: string, status = 'completed'): ChatPart => ({ type: 'tool', toolName: 'commandExecution', status,
  data: { type: 'commandExecution', command: value, aggregatedOutput: status === 'failed' ? 'One assertion failed' : 'All checks passed', exitCode: status === 'failed' ? 1 : status === 'running' ? undefined : 0 } });
const edit = (path: string): ChatPart => ({ type: 'tool', toolName: 'Edit', status: 'completed',
  data: { input: { file_path: path, old_string: 'before', new_string: 'after' }, result: 'Updated successfully' } });
const start = (child: Session, provider: Session['provider']): ChatPart => {
  const result = { delegationId: child.delegation!.id, sessionId: child.id, agent: child.provider, state: child.delegation!.state,
    workspace: child.delegation!.workspace, workspacePath: 'D:/work/task-map', branch: child.delegation!.branch };
  const args = { agent: child.provider, prompt: `Investigate ${child.id} and report your findings.`, title: child.title };
  return provider === 'codex'
    ? { type: 'tool', toolName: 'mcpToolCall', toolId: `start-${child.id}`, status: 'completed', data: { type: 'mcpToolCall', server: 'threadterm', tool: 'delegate_start', arguments: args, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } }
    : { type: 'tool', toolName: `${provider === 'grok' ? 'threadterm__' : 'mcp__threadterm__'}delegate_start`, status: 'completed', data: { input: args, result: [{ type: 'text', text: JSON.stringify(result) }] } };
};
const wait = (child: Session, codex = true): ChatPart => codex
  ? { type: 'tool', toolName: 'mcpToolCall', status: 'completed', data: { type: 'mcpToolCall', server: 'threadterm', tool: 'delegate_wait', arguments: { delegationId: child.delegation!.id }, result: { state: 'completed', summary: 'Investigation completed' } } }
  : { type: 'tool', toolName: 'mcp__threadterm__delegate_result', status: 'completed', data: { input: { delegationId: child.delegation!.id }, result: 'Investigation completed' } };
const native = (status: 'running' | 'completed', tools: number): ChatPart => ({ type: 'subagent', toolId: 'native-review', status,
  data: { key: 'native-review', provider: 'codex', name: '/root/review', agentType: 'explorer', description: 'Check the validation flow',
    prompt: 'Inspect validation and identify the callers.', status, startedAt: at(12), ...(status === 'completed' ? { endedAt: at(28), summary: 'Validation callers are covered.' } : {}), toolCount: tools, transcript: 'native' } });
const approval = (): ChatPart => ({ type: 'approval', approvalId: 'approval-publish', status: 'pending', data: {
  approvalId: 'approval-publish', sessionId: 'root', turnId: 'turn-3', provider: 'codex', requestType: 'commandExecution',
  interaction: 'permission', title: 'Publish the reviewed changes?', details: { command: 'git push' }, choices: [
    { choiceId: 'allow', label: 'Allow once', kind: 'allow', scope: 'once' }, { choiceId: 'deny', label: 'Deny', kind: 'deny', scope: 'once' },
  ],
} });

function delegation(): TaskMapFixture {
  const root = { ...session('root', 'codex'), status: 'waiting' as const };
  const claude = session('claude', 'claude', 5, root.id);
  claude.delegation = { ...claude.delegation!, workspace: 'worktree', branch: 'task-map/research' };
  const kimi = session('kimi', 'kimi', 6, root.id), grok = session('grok', 'grok', 15, claude.id);
  const rootItems: ChatItem[] = [
    item('root-prompt-1', 0, 'turn-1', 'user', [text('Map the validation flow\nInclude delegated work and changed files.')]),
    item('root-plan', 1, 'turn-1', 'assistant', [{ type: 'plan', data: { entries: [
      { content: 'Explore the code', status: 'in_progress' }, { content: 'Implement and review', status: 'pending' },
    ] } }]),
    item('root-commentary', 2, 'turn-1', 'assistant', [text('I will ask the other agents to inspect the providers.', 'commentary')]),
    item('root-delegate-claude', 5, 'turn-1', 'assistant', [start(claude, 'codex')]),
    item('root-delegate-kimi', 6, 'turn-1', 'assistant', [start(kimi, 'codex')]),
    item('root-explore', 8, 'turn-1', 'assistant', [read('renderer/src/validation.ts'), read('protocol/index.ts'),
      { type: 'tool', toolName: 'commandExecution', status: 'completed', data: { type: 'commandExecution', command: 'rg validate renderer/src', commandActions: [{ type: 'search', command: 'rg validate renderer/src' }], exitCode: 0 } }]),
    item('root-native-start', 12, 'turn-1', 'assistant', [native('running', 0)]),
    item('root-native-done', 28, 'turn-1', 'assistant', [native('completed', 4)]),
    item('root-browser', 30, 'turn-1', 'assistant', [{ type: 'tool', toolName: 'mcp__playwright__browser_navigate', status: 'completed', data: { input: { url: 'https://example.test/docs' }, result: 'Documentation' } }]),
    item('root-results', 40, 'turn-1', 'assistant', [wait(claude), wait(kimi)]),
    item('root-edits', 42, 'turn-1', 'assistant', [edit('renderer/src/validation.ts'), edit('docs/plan.md')]),
    item('root-plan-done', 45, 'turn-1', 'assistant', [{ type: 'plan', data: { entries: [
      { content: 'Explore the code', status: 'completed' }, { content: 'Implement and review', status: 'completed' },
    ] } }]),
    item('root-answer-1', 50, 'turn-1', 'assistant', [text('Implemented validation and documented the findings.', 'final_answer')],
      { elapsedMs: 50_000, turnStatus: 'completed', turnReview: { from: 'checkpoint-before-1', to: 'checkpoint-after-1', fileCount: 2 } }),
    item('root-prompt-2', 60, 'turn-2', 'user', [text('Run the checks and fix the failing case.')]),
    item('root-failed', 64, 'turn-2', 'assistant', [command('npm test -- validation', 'failed')]),
    item('root-error', 65, 'turn-2', 'assistant', [{ type: 'error', text: 'The validation test failed for an empty session id.' }]),
    item('root-question', 67, 'turn-2', 'assistant', [{ type: 'tool', toolName: 'mcp__threadterm__ask_user', status: 'completed', data: { input: { question: 'Reject empty ids?' }, result: 'Yes' } }]),
    item('root-fix', 72, 'turn-2', 'assistant', [edit('renderer/src/validation.ts')]),
    item('root-check', 80, 'turn-2', 'assistant', [command('npm test -- validation')]),
    item('root-mcp', 82, 'turn-2', 'assistant', [{ type: 'tool', toolName: 'mcpToolCall', status: 'completed', data: { type: 'mcpToolCall', server: 'codegraph', tool: 'context', arguments: { name: 'validate' }, result: { callers: ['save'] } } }]),
    item('root-answer-2', 90, 'turn-2', 'assistant', [text('The empty-id regression is fixed and the checks pass.', 'final_answer')],
      { elapsedMs: 30_000, turnStatus: 'completed', turnReview: { from: 'checkpoint-before-2', to: 'checkpoint-after-2', fileCount: 1 } }),
    item('root-prompt-3', 120, 'turn-3', 'user', [text('Publish the reviewed changes.')]),
    item('root-approval', 123, 'turn-3', 'assistant', [approval()]),
  ];
  return { rootSessionId: root.id, sessions: [root, kimi, grok, claude], documents: [
    { path: 'docs/plan.md', title: 'Validation plan', pinnedAt: at(51) },
    { path: 'docs/notes.md', title: 'Research notes', pinnedAt: at(91) },
  ], items: new Map([
    [root.id, rootItems],
    [claude.id, [
      item('claude-prompt', 5, 'claude-turn', 'user', [text('Inspect the validation callers and delegate provider checks.')]),
      item('claude-read', 7, 'claude-turn', 'assistant', [read('runtime/src/workspace_services.rs')]),
      item('claude-delegate-grok', 15, 'claude-turn', 'assistant', [start(grok, 'claude')]),
      item('claude-result-grok', 30, 'claude-turn', 'assistant', [wait(grok, false)]),
      item('claude-edit', 32, 'claude-turn', 'assistant', [edit('docs/provider-notes.md')]),
      item('claude-answer', 38, 'claude-turn', 'assistant', [text('All provider callers are covered.')], { turnStatus: 'completed', elapsedMs: 33_000 }),
    ]],
    [kimi.id, [item('kimi-prompt', 6, 'kimi-turn', 'user', [text('Check the protocol contracts.')]),
      item('kimi-read', 9, 'kimi-turn', 'assistant', [read('protocol/contracts.test.mjs')]),
      item('kimi-answer', 35, 'kimi-turn', 'assistant', [text('The protocol rejects empty session ids.')], { turnStatus: 'completed', elapsedMs: 29_000 })]],
    [grok.id, [item('grok-prompt', 15, 'grok-turn', 'user', [text('Check provider error handling.')]),
      item('grok-command', 18, 'grok-turn', 'assistant', [{ type: 'tool', toolName: 'Bash', status: 'completed', data: { input: { command: 'node --check provider.mjs' }, result: '' } }]),
      item('grok-answer', 25, 'grok-turn', 'assistant', [text('Provider error handling is consistent.')], { turnStatus: 'completed', elapsedMs: 10_000 })]],
  ]) };
}

/** Fresh deterministic provider-shaped data for unit tests and the visual harness. */
export function taskMapFixture(name: TaskMapFixtureName): TaskMapFixture {
  if (name === 'parallel') return parallel();
  if (name === 'nested') return nested();
  if (name === 'delegation') return delegation();
  if (name === 'running') {
    const fixture = delegation();
    fixture.sessions[0] = { ...fixture.sessions[0]!, status: 'running', activity: { state: 'running', revision: 1, turnId: 'turn-3' } };
    const child = { ...session('live-child', 'claude', 124, fixture.rootSessionId), status: 'running' as const };
    child.delegation = { ...child.delegation!, state: 'running' };
    fixture.sessions.push(child);
    const rootItems = fixture.items.get(fixture.rootSessionId)!;
    rootItems[rootItems.length - 1] = item('root-live', 124, 'turn-3', 'assistant', [
      text('The checks are still running.', 'final_answer'), command('npm run verify', 'running'), start(child, 'codex'),
    ]);
    rootItems.at(-1)!.parts[0]!.status = 'streaming';
    fixture.items.set(child.id, [item('live-prompt', 124, 'live-turn', 'user', [text('Monitor the verification output.')]),
      item('live-command', 125, 'live-turn', 'assistant', [command('npm run verify:provider', 'running')])]);
    return fixture;
  }
  const root = session('root', name === 'single' ? 'claude' : 'codex');
  if (name === 'single') root.title = 'Explain workspace validation';
  if (name === 'long') root.title = 'Verify workspace validation edge cases';
  const fixture: TaskMapFixture = { rootSessionId: root.id, sessions: [root], items: new Map([[root.id, []]]), documents: [] };
  const items = fixture.items.get(root.id)!;
  if (name === 'single') items.push(item('single-prompt', 0, 'single-turn', 'user', [text('Explain how validation works.')]),
    item('single-answer', 2, 'single-turn', 'assistant', [text('Validation checks the input before persisting it.')], { elapsedMs: 2_000, turnStatus: 'completed' }));
  if (name === 'long') for (let turn = 0; turn < 200; turn += 1) {
    const turnId = `long-turn-${turn}`, base = turn * 30;
    items.push(item(`long-prompt-${turn}`, base, turnId, 'user', [text(`Investigate case ${turn + 1} and verify the result.`)]));
    const tools: ChatPart[] = [];
    for (let index = 0; index < 15; index += 1) tools.push(index % 5 === 0 ? read(`src/case-${turn}-${index}.ts`)
      : index % 5 === 1 ? { type: 'tool', toolName: 'Grep', status: 'completed', data: { input: { pattern: `case${turn}`, path: 'src' }, result: '2 matches' } }
      : index % 5 === 2 ? command('node --check index.mjs', turn % 17 === 0 ? 'failed' : 'completed')
      : index % 5 === 3 ? edit(`src/case-${turn}.ts`)
      : { type: 'tool', toolName: 'mcpToolCall', status: 'completed', data: { type: 'mcpToolCall', server: 'codegraph', tool: 'context', arguments: { name: `case${turn}` }, result: { found: true } } });
    items.push(item(`long-tools-${turn}`, base + 2, turnId, 'assistant', tools));
    items.push(item(`long-answer-${turn}`, base + 20, turnId, 'assistant', [text(`Case ${turn + 1} is verified.`, 'final_answer')], { elapsedMs: 20_000, turnStatus: 'completed' }));
  }
  return fixture;
}

/** Latest valid item timestamp across every lane; zero when there are no dated items. */
export function taskMapFixtureLastTime(fixture: TaskMapFixture): number {
  let latest = -Infinity;
  for (const items of fixture.items.values()) for (const item of items) {
    const timestamp = Date.parse(item.createdAt);
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return Number.isFinite(latest) ? latest : 0;
}

/** Cross-turn delegated work, overlapping branches, anchored native work and an orphan branch. */
function nested(): TaskMapFixture {
  const fixture = delegation();
  const child = session('unanchored', 'kimi', 70, 'root');
  fixture.sessions.push(child);
  fixture.items.set(child.id, [item('unanchored-prompt', 70, 'orphan-turn', 'user', [text('Inspect an imported delegate without a start record.')]),
    item('unanchored-read', 71, 'orphan-turn', 'assistant', [read('docs/import.md')]),
    item('unanchored-answer', 74, 'orphan-turn', 'assistant', [text('Imported delegate history is available.')], { turnStatus: 'completed', elapsedMs: 4_000 })]);
  fixture.items.get('claude')!.push(
    item('claude-later-edit', 75, 'claude-turn-2', 'assistant', [edit('docs/later.md')]),
    item('claude-later-answer', 85, 'claude-turn-2', 'assistant', [text('Follow-up changes are complete.')],
      { turnStatus: 'completed', elapsedMs: 10_000, turnReview: { from: 'claude-before', to: 'claude-after', fileCount: 1 } }));
  fixture.documents.push({ path: 'docs/later.md', title: 'Delegate follow-up', pinnedAt: at(86) });
  const nativeFirst = native('completed', 2);
  nativeFirst.toolId = 'native-first';
  nativeFirst.data = { ...nativeFirst.data as object, key: 'native-first', startedAt: at(121), endedAt: at(122) };
  fixture.items.get('root')!.splice(fixture.items.get('root')!.length - 1, 0, item('native-first-item', 121, 'turn-3', 'assistant', [nativeFirst]));
  return fixture;
}

/** Two concurrent siblings, then a later branch that can reuse their column. */
function parallel(): TaskMapFixture {
  const root = session('root', 'codex'), claude = session('claude', 'claude', 5, root.id);
  const kimi = session('kimi', 'kimi', 6, root.id), grok = session('grok', 'grok', 65, root.id);
  const subagent = native('completed', 4);
  subagent.data = { ...subagent.data as object, startedAt: at(68), endedAt: at(82) };
  return { rootSessionId: root.id, sessions: [root, claude, kimi, grok],
    documents: [{ path: 'docs/parallel-plan.md', title: 'Parallel validation plan', pinnedAt: at(45) }], items: new Map([
      [root.id, [
        item('root-prompt-1', 0, 'turn-1', 'user', [text('Investigate validation in parallel and review the changes.')]),
        item('root-explore', 2, 'turn-1', 'assistant', [read('renderer/src/validation.ts'), read('protocol/index.ts')]),
        item('root-delegate-claude', 5, 'turn-1', 'assistant', [start(claude, 'codex')]),
        item('root-delegate-kimi', 6, 'turn-1', 'assistant', [start(kimi, 'codex')]),
        item('root-command', 14, 'turn-1', 'assistant', [command('node --check validation.mjs')]),
        item('root-results', 40, 'turn-1', 'assistant', [wait(claude), wait(kimi, false)]),
        item('root-answer-1', 50, 'turn-1', 'assistant', [text('Both investigations are complete.', 'final_answer')],
          { turnStatus: 'completed', elapsedMs: 50_000, turnReview: { from: 'parallel-root-before', to: 'parallel-root-after', fileCount: 2 } }),
        item('root-prompt-2', 60, 'turn-2', 'user', [text('Check the providers and run the native review.')]),
        item('root-delegate-grok', 65, 'turn-2', 'assistant', [start(grok, 'codex')]),
        item('root-native', 68, 'turn-2', 'assistant', [subagent]),
        item('root-result-grok', 88, 'turn-2', 'assistant', [wait(grok)]),
        item('root-answer-2', 95, 'turn-2', 'assistant', [text('Provider checks and native review passed.', 'final_answer')],
          { turnStatus: 'completed', elapsedMs: 35_000 }),
        item('root-prompt-3', 120, 'turn-3', 'user', [text('Summarize the final validation checks.')]),
        item('root-final-explore', 122, 'turn-3', 'assistant', [read('docs/parallel-plan.md')]),
        item('root-answer-3', 130, 'turn-3', 'assistant', [text('All validation checks are documented.', 'final_answer')],
          { turnStatus: 'completed', elapsedMs: 10_000 }),
      ]],
      [claude.id, [
        item('claude-prompt', 5, 'claude-turn', 'user', [text('Inspect validation callers.')]),
        item('claude-read', 7, 'claude-turn', 'assistant', [read('runtime/src/workspace_services.rs')]),
        item('claude-command', 18, 'claude-turn', 'assistant', [command('node --check callers.mjs')]),
        item('claude-read-more', 25, 'claude-turn', 'assistant', [read('protocol/index.ts')]),
        item('claude-answer', 35, 'claude-turn', 'assistant', [text('Validation callers are covered.')],
          { turnStatus: 'completed', elapsedMs: 30_000 }),
      ]],
      [kimi.id, [
        item('kimi-prompt', 6, 'kimi-turn', 'user', [text('Edit the protocol contract and document the plan.')]),
        item('kimi-edit', 9, 'kimi-turn', 'assistant', [edit('protocol/contracts.test.mjs'), edit('docs/parallel-plan.md')]),
        item('kimi-command', 20, 'kimi-turn', 'assistant', [command('node --check contracts.test.mjs')]),
        item('kimi-answer', 33, 'kimi-turn', 'assistant', [text('Protocol contracts and the plan are updated.')],
          { turnStatus: 'completed', elapsedMs: 27_000, turnReview: { from: 'parallel-kimi-before', to: 'parallel-kimi-after', fileCount: 2 } }),
      ]],
      [grok.id, [
        item('grok-prompt', 65, 'grok-turn', 'user', [text('Check provider error paths.')]),
        item('grok-command', 70, 'grok-turn', 'assistant', [command('node --check provider.mjs')]),
        item('grok-answer', 85, 'grok-turn', 'assistant', [text('Provider errors are covered.')],
          { turnStatus: 'completed', elapsedMs: 20_000 }),
      ]],
    ]) };
}
