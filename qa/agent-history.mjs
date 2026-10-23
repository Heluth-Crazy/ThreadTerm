// Removes the agent history a live QA probe leaves in the user's own agent folders.
// `slug` is a lower-case fragment of the probe's scratch folder name (every probe
// workspace lives under it): ~/.claude/projects folders, Codex rollouts plus their
// state_5 / thread_history_1 rows, Kimi session folders, index lines and workspace entries,
// and Grok session folders, active-session rows, and indexed path rows.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function cleanClaude(slug, home) {
  const projects = join(home, '.claude', 'projects');
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    if (dir.toLowerCase().includes(slug)) { rmSync(join(projects, dir), { recursive: true, force: true }); console.log(`removed Claude history ${dir}`); }
  }
}

function cleanCodex(slug, home) {
  const codex = join(home, '.codex');
  if (!existsSync(join(codex, 'state_5.sqlite'))) return;
  const state = new DatabaseSync(join(codex, 'state_5.sqlite'));
  state.exec('PRAGMA busy_timeout = 5000');
  const threads = state.prepare('SELECT id, rollout_path FROM threads WHERE lower(cwd) LIKE ?').all(`%${slug}%`);
  const transaction = (db, statements) => {
    db.exec('BEGIN IMMEDIATE');
    try { for (const [sql, id] of statements) db.prepare(sql).run(id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  for (const { id, rollout_path: rollout } of threads) {
    if (rollout && existsSync(rollout)) rmSync(rollout, { force: true });
    transaction(state, [['DELETE FROM thread_dynamic_tools WHERE thread_id=?', id], ['DELETE FROM thread_attachments WHERE thread_id=?', id], ['DELETE FROM threads WHERE id=?', id]]);
    const history = new DatabaseSync(join(codex, 'thread_history_1.sqlite'));
    history.exec('PRAGMA busy_timeout = 5000');
    transaction(history, [['DELETE FROM thread_items WHERE thread_id=?', id], ['DELETE FROM thread_turns WHERE thread_id=?', id], ['DELETE FROM thread_history_projection_state WHERE thread_id=?', id]]);
    history.close();
    console.log(`removed Codex thread ${id}`);
  }
  state.close();
}

function cleanKimi(slug, home) {
  const kimi = join(home, '.kimi-code');
  const indexPath = join(kimi, 'session_index.jsonl');
  const workspacesPath = join(kimi, 'workspaces.json');
  if (!existsSync(workspacesPath)) return;
  const workspaces = JSON.parse(readFileSync(workspacesPath, 'utf8'));
  const keys = Object.entries(workspaces.workspaces ?? {}).filter(([, value]) => String(value.root ?? '').toLowerCase().includes(slug)).map(([key]) => key);
  const sessionIds = new Set();
  for (const key of keys) {
    const dir = join(kimi, 'sessions', key);
    for (const name of existsSync(dir) ? readdirSync(dir) : []) if (name.startsWith('session_')) sessionIds.add(name);
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(kimi, 'file-history', key), { recursive: true, force: true });
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
  const dirty = join(kimi, 'sessions', '.index-dirty');
  for (const name of existsSync(dirty) ? readdirSync(dirty) : []) {
    if ([...sessionIds].some(id => name.startsWith(`${id}.`))) rmSync(join(dirty, name), { force: true });
  }
}

const quoted = name => `"${String(name).replaceAll('"', '""')}"`;
const pathColumns = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  .flatMap(({ name }) => db.prepare(`PRAGMA table_info(${quoted(name)})`).all()
    .filter(column => /cwd|path|workspace|root/i.test(String(column.name)) && /char|text|clob/i.test(String(column.type ?? '')))
    .map(column => ({ table: name, column: column.name })));

function cleanGrok(slug, home) {
  const grok = join(home, '.grok');
  const sessions = join(grok, 'sessions');
  for (const name of existsSync(sessions) ? readdirSync(sessions) : []) {
    let decoded;
    try { decoded = decodeURIComponent(name); } catch { continue; }
    if (decoded.toLowerCase().includes(slug)) {
      rmSync(join(sessions, name), { recursive: true, force: true });
      console.log(`removed Grok history ${name}`);
    }
  }
  const active = join(grok, 'active_sessions.json');
  if (existsSync(active)) {
    try {
      const entries = JSON.parse(readFileSync(active, 'utf8'));
      if (Array.isArray(entries)) {
        const kept = entries.filter(entry => !String(entry?.cwd ?? '').toLowerCase().includes(slug));
        if (kept.length !== entries.length) writeFileSync(active, `${JSON.stringify(kept, null, 2)}\n`);
      }
    } catch (error) { console.log(`Grok active-session cleanup failed: ${error.message}`); }
  }
  const search = join(grok, 'session_search.sqlite');
  if (!existsSync(search)) return;
  let db;
  try {
    db = new DatabaseSync(search);
    let removed = 0;
    for (const { table, column } of pathColumns(db)) {
      removed += db.prepare(`DELETE FROM ${quoted(table)} WHERE lower(${quoted(column)}) LIKE ?`).run(`%${slug}%`).changes;
    }
    if (removed) console.log(`removed ${removed} Grok session-search row(s)`);
  } catch (error) { console.log(`Grok session-search cleanup failed: ${error.message}`); }
  finally { db?.close(); }
}

/** Anything left that still names this probe's folder. */
function leftovers(slug, home) {
  const found = [];
  const scan = (dir, depth) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (name.toLowerCase().includes(slug)) { found.push(path); continue; }
      if (depth > 0) { try { if (statSync(path).isDirectory()) scan(path, depth - 1); } catch {} }
    }
  };
  scan(join(home, '.claude', 'projects'), 0);
  scan(join(home, '.kimi-code', 'sessions'), 1);
  const grokSessions = join(home, '.grok', 'sessions');
  for (const name of existsSync(grokSessions) ? readdirSync(grokSessions) : []) {
    try { if (decodeURIComponent(name).toLowerCase().includes(slug)) found.push(join(grokSessions, name)); } catch {}
  }
  for (const file of [join(home, '.kimi-code', 'session_index.jsonl'), join(home, '.kimi-code', 'workspaces.json'), join(home, '.grok', 'active_sessions.json')]) {
    if (existsSync(file) && readFileSync(file, 'utf8').toLowerCase().includes(slug)) found.push(file);
  }
  try {
    const state = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'), { readOnly: true });
    const count = state.prepare('SELECT COUNT(*) AS n FROM threads WHERE lower(cwd) LIKE ?').get(`%${slug}%`).n;
    if (count) found.push(`~/.codex/state_5.sqlite threads ×${count}`);
    state.close();
  } catch {}
  try {
    const search = new DatabaseSync(join(home, '.grok', 'session_search.sqlite'), { readOnly: true });
    const matches = pathColumns(search).reduce((count, { table, column }) => count + search.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE lower(${quoted(column)}) LIKE ?`).get(`%${slug}%`).n, 0);
    if (matches) found.push(`~/.grok/session_search.sqlite rows ×${matches}`);
    search.close();
  } catch {}
  return found;
}

/** Cleans every agent's history for `slug` and logs what (if anything) is still left. */
export function removeAgentHistory(slug, { home = homedir() } = {}) {
  const key = String(slug).toLowerCase();
  for (const [name, clean] of [['Claude', cleanClaude], ['Codex', cleanCodex], ['Kimi', cleanKimi], ['Grok', cleanGrok]]) {
    try { clean(key, home); } catch (error) { console.log(`${name} cleanup failed: ${error.message}`); }
  }
  const left = leftovers(key, home);
  console.log(left.length ? `HISTORY LEFT: ${left.join(' | ')}` : 'probe history removed');
  return left;
}
