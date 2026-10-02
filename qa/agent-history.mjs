// Removes the agent history a live QA probe leaves in the user's own agent folders.
// `slug` is a lower-case fragment of the probe's scratch folder name (every probe
// workspace lives under it): ~/.claude/projects folders, Codex rollouts plus their
// state_5 / thread_history_1 rows, Kimi session folders, index lines and workspace entries.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function cleanClaude(slug) {
  const projects = join(homedir(), '.claude', 'projects');
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    if (dir.toLowerCase().includes(slug)) { rmSync(join(projects, dir), { recursive: true, force: true }); console.log(`removed Claude history ${dir}`); }
  }
}

function cleanCodex(slug) {
  const home = join(homedir(), '.codex');
  if (!existsSync(join(home, 'state_5.sqlite'))) return;
  const state = new DatabaseSync(join(home, 'state_5.sqlite'));
  state.exec('PRAGMA busy_timeout = 5000');
  const threads = state.prepare('SELECT id, rollout_path FROM threads WHERE lower(cwd) LIKE ?').all(`%${slug}%`);
  const transaction = (db, statements) => {
    db.exec('BEGIN IMMEDIATE');
    try { for (const [sql, id] of statements) db.prepare(sql).run(id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  for (const { id, rollout_path: rollout } of threads) {
    if (rollout && existsSync(rollout)) rmSync(rollout, { force: true });
    transaction(state, [['DELETE FROM thread_dynamic_tools WHERE thread_id=?', id], ['DELETE FROM thread_attachments WHERE thread_id=?', id], ['DELETE FROM threads WHERE id=?', id]]);
    const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    history.exec('PRAGMA busy_timeout = 5000');
    transaction(history, [['DELETE FROM thread_items WHERE thread_id=?', id], ['DELETE FROM thread_turns WHERE thread_id=?', id], ['DELETE FROM thread_history_projection_state WHERE thread_id=?', id]]);
    history.close();
    console.log(`removed Codex thread ${id}`);
  }
  state.close();
}

function cleanKimi(slug) {
  const home = join(homedir(), '.kimi-code');
  const indexPath = join(home, 'session_index.jsonl');
  const workspacesPath = join(home, 'workspaces.json');
  if (!existsSync(workspacesPath)) return;
  const workspaces = JSON.parse(readFileSync(workspacesPath, 'utf8'));
  const keys = Object.entries(workspaces.workspaces ?? {}).filter(([, value]) => String(value.root ?? '').toLowerCase().includes(slug)).map(([key]) => key);
  const sessionIds = new Set();
  for (const key of keys) {
    const dir = join(home, 'sessions', key);
    for (const name of existsSync(dir) ? readdirSync(dir) : []) if (name.startsWith('session_')) sessionIds.add(name);
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(home, 'file-history', key), { recursive: true, force: true });
    delete workspaces.workspaces[key];
    console.log(`removed Kimi workspace ${key}`);
  }
  if (keys.length) writeFileSync(workspacesPath, JSON.stringify(workspaces));
  if (existsSync(indexPath)) {
    const lines = readFileSync(indexPath, 'utf8').split('\n');
    const kept = lines.filter(line => {
      if (!line.toLowerCase().includes(slug)) return true;
      try { sessionIds.add(JSON.parse(line).sessionId); } catch {}
      return false;
    });
    if (kept.length !== lines.length) writeFileSync(indexPath, kept.join('\n'));
  }
  const dirty = join(home, 'sessions', '.index-dirty');
  for (const name of existsSync(dirty) ? readdirSync(dirty) : []) {
    if ([...sessionIds].some(id => name.startsWith(`${id}.`))) rmSync(join(dirty, name), { force: true });
  }
}

/** Anything left that still names this probe's folder. */
function leftovers(slug) {
  const found = [];
  const scan = (dir, depth) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (name.toLowerCase().includes(slug)) { found.push(path); continue; }
      if (depth > 0) { try { if (statSync(path).isDirectory()) scan(path, depth - 1); } catch {} }
    }
  };
  scan(join(homedir(), '.claude', 'projects'), 0);
  scan(join(homedir(), '.kimi-code', 'sessions'), 1);
  for (const file of [join(homedir(), '.kimi-code', 'session_index.jsonl'), join(homedir(), '.kimi-code', 'workspaces.json')]) {
    if (existsSync(file) && readFileSync(file, 'utf8').toLowerCase().includes(slug)) found.push(file);
  }
  try {
    const state = new DatabaseSync(join(homedir(), '.codex', 'state_5.sqlite'), { readOnly: true });
    const count = state.prepare('SELECT COUNT(*) AS n FROM threads WHERE lower(cwd) LIKE ?').get(`%${slug}%`).n;
    if (count) found.push(`~/.codex/state_5.sqlite threads ×${count}`);
    state.close();
  } catch {}
  return found;
}

/** Cleans every agent's history for `slug` and logs what (if anything) is still left. */
export function removeAgentHistory(slug) {
  for (const [name, clean] of [['Claude', cleanClaude], ['Codex', cleanCodex], ['Kimi', cleanKimi]]) {
    try { clean(slug); } catch (error) { console.log(`${name} cleanup failed: ${error.message}`); }
  }
  const left = leftovers(slug);
  console.log(left.length ? `HISTORY LEFT: ${left.join(' | ')}` : 'probe history removed');
  return left;
}
