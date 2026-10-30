import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '@threadterm/protocol';
import {
 agentStartLabel, createRunCurrentConfigs, currentRunEntry, detectedCommandId, detectedKeyOf, entryRefOf, filterRunEntries, formatUptime, lastRunEntry,
 paletteRunEntries, runKeyAction, runningRows, RUN_SHORTCUTS, runShortcutLabel, startedByChat, uptimeMs, worktreeLabel,
} from './runView';

type Run = { commandId:string; name:string; kind:'service'|'task' };
const session = (id:string, worktreePath:string, created:string, run?:Run, status:Session['status'] = 'running'):Session => ({
 id, projectId:'p1', worktreePath, title:run?.name ?? id, provider:'custom', mode:'terminal', status, createdAt:created, updatedAt:created,
 ...(run ? { run:{ commandId:run.commandId, name:run.name, kind:run.kind, shell:'cmd' } } : {}),
}) as Session;

test('running lists every worktree of the project, the current one first and then the newest', () => {
 const sessions = [
  session('old-other', 'C:\\work\\feature-a', '2026-01-01T10:00:00Z', { commandId:'dev', name:'dev', kind:'service' }),
  session('new-other', 'C:\\work\\feature-b', '2026-01-01T12:00:00Z', { commandId:'dev', name:'dev', kind:'service' }),
  session('here', 'C:\\Work\\Main', '2026-01-01T09:00:00Z', { commandId:'build', name:'build', kind:'task' }),
  session('stopped', 'C:\\work\\main', '2026-01-01T13:00:00Z', { commandId:'build', name:'build', kind:'task' }, 'exited'),
  session('elsewhere', 'C:\\other', '2026-01-01T14:00:00Z', { commandId:'dev', name:'dev', kind:'service' }),
 ] as Session[];
 sessions.push({ ...session('not-a-run', 'C:\\work\\main', '2026-01-01T15:00:00Z') });
 sessions[4] = { ...sessions[4], projectId:'p2' };
 const rows = runningRows(sessions, { projectId:'p1', root:'c:/work/main' });
 assert.deepEqual(rows.map(row => row.session.id), ['here', 'new-other', 'old-other']);
 assert.deepEqual(rows.map(row => row.current), [true, false, false]);
 assert.deepEqual(rows.map(row => row.worktree), ['Main', 'feature-b', 'feature-a']);
 assert.equal(rows[0].state.state, 'running');
});

test('a run stays out of Running once it stopped, failed, was archived or is a foreign project', () => {
 const sessions = [
  session('archived', 'C:\\work\\main', '2026-01-01T10:00:00Z', { commandId:'dev', name:'dev', kind:'service' }),
  session('failed', 'C:\\work\\main', '2026-01-01T10:00:00Z', { commandId:'dev2', name:'dev2', kind:'service' }, 'error'),
  session('saved', 'C:\\work\\main', '2026-01-01T11:00:00Z', { commandId:'dev', name:'dev', kind:'service' }),
 ] as Session[];
 sessions[0] = { ...sessions[0], archived:true };
 assert.deepEqual(runningRows(sessions, { projectId:'p1', root:'C:\\work\\main' }).map(row => row.session.id), ['saved']);
 assert.deepEqual(runningRows(sessions, { projectId:'p2', root:'C:\\work\\main' }), []);
});

test('the current configuration is the last run of this worktree until one is chosen by hand', () => {
 const sessions = [
  session('one', 'C:\\work\\main', '2026-01-01T10:00:00Z', { commandId:'dev', name:'dev', kind:'service' }),
  session('two', 'C:\\work\\main', '2026-01-01T12:00:00Z', { commandId:detectedCommandId('node:package.json:build'), name:'build', kind:'task' }, 'exited'),
  session('other', 'C:\\work\\feature', '2026-01-01T13:00:00Z', { commandId:'test', name:'test', kind:'task' }),
 ] as Session[];
 const scope = { projectId:'p1', root:'c:\\work\\main' };
 assert.deepEqual(lastRunEntry(scope, sessions), { commandId:'detected:node:package.json:build', name:'build', source:'detected' });
 assert.deepEqual(currentRunEntry(scope, sessions, undefined), lastRunEntry(scope, sessions));
 const configs = createRunCurrentConfigs();
 configs.choose(scope, { commandId:'dev', name:'dev', source:'saved' });
 assert.deepEqual(currentRunEntry(scope, sessions, configs.get(scope)), { commandId:'dev', name:'dev', source:'saved' });
 // Renderer memory is per (project, worktree): another worktree keeps its own derived choice.
 const other = { projectId:'p1', root:'C:\\work\\feature' };
 assert.equal(configs.get(other), undefined);
 assert.deepEqual(currentRunEntry(other, sessions, configs.get(other)), { commandId:'test', name:'test', source:'saved' });
 configs.forget(scope);
 assert.equal(configs.get(scope), undefined);
 assert.equal(currentRunEntry({ projectId:'p2', root:'C:\\work\\main' }, sessions, undefined), undefined);
});

test('detected ids round-trip and name their source', () => {
 assert.equal(detectedCommandId('node:package.json:dev'), 'detected:node:package.json:dev');
 assert.equal(detectedKeyOf('detected:node:package.json:dev'), 'node:package.json:dev');
 assert.equal(detectedKeyOf('a9471c2e-0000'), undefined);
 assert.deepEqual(entryRefOf('detected:make:Makefile:build', 'build'), { commandId:'detected:make:Makefile:build', name:'build', source:'detected' });
 assert.deepEqual(entryRefOf('saved-id', 'Dev'), { commandId:'saved-id', name:'Dev', source:'saved' });
});

test('the filter box matches a name, a command or a group and keeps an empty query unchanged', () => {
 const entries = [
  { name:'dev', command:'npm run dev', detail:'package.json' },
  { name:'build', command:'npm run build', detail:'package.json' },
  { name:'web', command:'docker compose up web', detail:'Compose services' },
 ];
 assert.deepEqual(filterRunEntries(entries, '').length, 3);
 assert.deepEqual(filterRunEntries(entries, '  NPM RUN B ').map(entry => entry.name), ['build']);
 assert.deepEqual(filterRunEntries(entries, 'compose').map(entry => entry.name), ['web']);
 assert.deepEqual(filterRunEntries(entries, 'nothing'), []);
});

test('uptime counts from the run start and reads compactly', () => {
 const started = '2026-01-01T10:00:00.000Z';
 assert.equal(uptimeMs(started, Date.parse(started) + 12_000), 12_000);
 assert.equal(uptimeMs(started, Date.parse(started) - 5_000), 0);
 assert.equal(uptimeMs('not a date', Date.now()), 0);
 assert.equal(formatUptime(4_000), '4s');
 assert.equal(formatUptime(200_000), '3m 20s');
 assert.equal(formatUptime(3_600_000 + 2 * 60_000), '1h 2m');
 assert.equal(formatUptime(-1), '0s');
});

test('the F5 keys are Ctrl+F5, Shift+F5 and Ctrl+Shift+F5 and nothing else', () => {
 assert.equal(runKeyAction({ key:'F5', ctrlKey:true }), 'run');
 assert.equal(runKeyAction({ key:'F5', shiftKey:true }), 'stop');
 assert.equal(runKeyAction({ key:'F5', ctrlKey:true, shiftKey:true }), 'restart');
 for (const event of [{ key:'F5' }, { key:'F5', ctrlKey:true, altKey:true }, { key:'F5', metaKey:true }, { key:'F4', ctrlKey:true }, { key:'f5', ctrlKey:true }])
  assert.equal(runKeyAction(event), undefined, JSON.stringify(event));
 assert.equal(RUN_SHORTCUTS.run, 'Control+F5');
 assert.equal(runShortcutLabel('restart'), 'Ctrl+Shift+F5');
 // The view itself has no shortcut: Ctrl+Shift+R is Electron's Force Reload.
 assert.ok(!Object.values(RUN_SHORTCUTS).includes('Control+Shift+R'));
});

test('palette Run entries keep at most 20 rows and address saved commands and detected keys differently', () => {
 const entries = [
  ...Array.from({ length: 25 }, (_, index) => ({ name:`s${index}`, command:`npm run s${index}`, commandId:`id-${index}`, source:'saved' as const })),
  { name:'dev', command:'npm run dev', commandId:'detected:node:package.json:dev', source:'detected' as const },
 ];
 const rows = paletteRunEntries(entries);
 assert.equal(rows.length, 20);
 assert.deepEqual(rows[0], { id:'saved:id-0', name:'s0', detail:'npm run s0', commandId:'id-0' });
 const short = paletteRunEntries(entries.slice(0, 2).concat([entries.at(-1)!]));
 assert.deepEqual(short.at(-1), { id:'detected:node:package.json:dev', name:'dev', detail:'npm run dev', detectedKey:'node:package.json:dev' });
});

test('worktree labels drop the runtime extended prefix and trailing separators', () => {
 assert.equal(worktreeLabel('\\\\?\\C:\\work\\ThreadTerm-v3\\'), 'ThreadTerm-v3');
 assert.equal(worktreeLabel('C:/work/feature-run'), 'feature-run');
 assert.equal(worktreeLabel(undefined), '');
});

test('an agent-started run names the chat that started it', () => {
 const chat = { ...session('chat-1', 'C:\\work\\main', '2026-01-01T09:00:00Z'), title:'Run tools QA', mode:'chat' } as Session;
 const sessions = [chat, session('editor', 'C:\\work\\main', '2026-01-01T10:00:00Z')];
 assert.equal(agentStartLabel('chat-1', sessions, false), 'Started by Run tools QA');
 assert.equal(agentStartLabel('chat-1', sessions, true), '由 Run tools QA 启动');
 assert.equal(agentStartLabel(undefined, sessions, false), undefined);
 assert.equal(agentStartLabel('gone', sessions, false), 'Started by gone', 'a chat that is gone keeps a truthful label');
 assert.equal(startedByChat('chat-1', sessions)?.id, 'chat-1');
 assert.equal(startedByChat('gone', sessions), undefined);
});
