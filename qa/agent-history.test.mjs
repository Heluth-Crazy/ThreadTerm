import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { removeAgentHistory } from './agent-history.mjs';

const tempRoot = 'D:/project/ThreadTerm/tt-qa-temp';
const slug = 'tt-history-fixture-4d2c';

function db(path, sql) {
  const value = new DatabaseSync(path);
  value.exec(sql);
  return value;
}

test('removeAgentHistory removes only a matching probe slug from every native store', async () => {
  const home = await mkdtemp(join(tempRoot, 'agent-history-'));
  try {
    const claude = join(home, '.claude', 'projects');
    mkdirSync(join(claude, `probe-${slug}`), { recursive: true });
    mkdirSync(join(claude, 'keep-project'), { recursive: true });

    const codex = join(home, '.codex');
    mkdirSync(codex, { recursive: true });
    const rollout = join(home, `${slug}.jsonl`);
    writeFileSync(rollout, 'probe');
    const state = db(join(codex, 'state_5.sqlite'), 'CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT); CREATE TABLE thread_dynamic_tools(thread_id TEXT); CREATE TABLE thread_attachments(thread_id TEXT);');
    state.prepare('INSERT INTO threads VALUES(?,?,?)').run('probe', rollout, `D:/scratch/${slug}/workspace`);
    state.prepare('INSERT INTO threads VALUES(?,?,?)').run('keep', join(home, 'keep.jsonl'), 'D:/other');
    state.prepare('INSERT INTO thread_dynamic_tools VALUES(?)').run('probe');
    state.prepare('INSERT INTO thread_attachments VALUES(?)').run('probe');
    state.close();
    const history = db(join(codex, 'thread_history_1.sqlite'), 'CREATE TABLE thread_items(thread_id TEXT); CREATE TABLE thread_turns(thread_id TEXT); CREATE TABLE thread_history_projection_state(thread_id TEXT);');
    for (const table of ['thread_items', 'thread_turns', 'thread_history_projection_state']) {
      history.prepare(`INSERT INTO ${table} VALUES(?)`).run('probe');
      history.prepare(`INSERT INTO ${table} VALUES(?)`).run('keep');
    }
    history.close();

    const kimi = join(home, '.kimi-code');
    mkdirSync(join(kimi, 'sessions', 'probe-key'), { recursive: true });
    mkdirSync(join(kimi, 'sessions', 'keep-key'), { recursive: true });
    mkdirSync(join(kimi, 'file-history', 'probe-key'), { recursive: true });
    writeFileSync(join(kimi, 'sessions', 'probe-key', 'session_probe'), 'probe');
    writeFileSync(join(kimi, 'sessions', 'keep-key', 'session_keep'), 'keep');
    writeFileSync(join(kimi, 'workspaces.json'), JSON.stringify({ workspaces: { 'probe-key': { root: `D:/scratch/${slug}` }, 'keep-key': { root: 'D:/other' } } }));
    writeFileSync(join(kimi, 'session_index.jsonl'), `${JSON.stringify({ sessionId: 'session_probe', cwd: slug })}\n${JSON.stringify({ sessionId: 'session_keep', cwd: 'other' })}\n`);

    const grok = join(home, '.grok');
    mkdirSync(join(grok, 'sessions', encodeURIComponent(`D:/scratch/${slug}/workspace`)), { recursive: true });
    mkdirSync(join(grok, 'sessions', encodeURIComponent('D:/other')), { recursive: true });
    writeFileSync(join(grok, 'active_sessions.json'), JSON.stringify([{ cwd: `D:/scratch/${slug}/workspace` }, { cwd: 'D:/other' }]));
    const search = db(join(grok, 'session_search.sqlite'), 'CREATE TABLE sessions(cwd TEXT, title TEXT);');
    search.prepare('INSERT INTO sessions VALUES(?,?)').run(`D:/scratch/${slug}/workspace`, 'probe');
    search.prepare('INSERT INTO sessions VALUES(?,?)').run('D:/other', slug);
    search.close();

    const left = removeAgentHistory(slug, { home });
    assert.deepEqual(left, []);
    assert.equal(existsSync(join(claude, `probe-${slug}`)), false);
    assert.equal(existsSync(join(claude, 'keep-project')), true);
    const remaining = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import { DatabaseSync } from 'node:sqlite';
      const state = new DatabaseSync(${JSON.stringify(join(codex, 'state_5.sqlite'))}, { readOnly: true });
      const search = new DatabaseSync(${JSON.stringify(join(grok, 'session_search.sqlite'))}, { readOnly: true });
      console.log(JSON.stringify({ threads: state.prepare('SELECT id FROM threads').all(), search: search.prepare('SELECT cwd,title FROM sessions').all() }));
      state.close(); search.close();
    `], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual(remaining, { threads: [{ id: 'keep' }], search: [{ cwd: 'D:/other', title: slug }] });
    assert.equal(existsSync(rollout), false);
    assert.equal(existsSync(join(kimi, 'sessions', 'probe-key')), false);
    assert.equal(existsSync(join(kimi, 'sessions', 'keep-key')), true);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(kimi, 'workspaces.json'), 'utf8')).workspaces), ['keep-key']);
    assert.equal(existsSync(join(grok, 'sessions', encodeURIComponent(`D:/scratch/${slug}/workspace`))), false);
    assert.equal(existsSync(join(grok, 'sessions', encodeURIComponent('D:/other'))), true);
    assert.deepEqual(JSON.parse(readFileSync(join(grok, 'active_sessions.json'), 'utf8')), [{ cwd: 'D:/other' }]);
  } finally {
    // node:sqlite can retain a Windows file handle briefly after close.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { await rm(home, { recursive: true, force: true }); break; }
      catch (error) {
        if (attempt === 9) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
});
