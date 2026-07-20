# Stats OpenCode Usage Ingestion

<spec-entry category="contract" keywords="stats,opencode,sqlite,usage_records,token-usage,terminal-type" date="2026-07-14" source="src-tauri/src/stats/opencode.rs:1">

## Scenario: OpenCode SQLite Usage Ingestion

### 1. Scope / Trigger
- Trigger: Any change to OpenCode token usage ingestion, stats provider scope handling, `usage_records` writes for OpenCode, or the `opencode` terminal type.
- Applies to `src-tauri/src/stats/opencode.rs`, `src-tauri/src/stats/sync.rs`, `src-tauri/src/stats/aggregate.rs`, `src/types/stats.ts`, `src/types/terminal.ts`, and terminal type metadata.

### 2. Signatures
- `opencode_db_path() -> PathBuf`
- `OpenCodeUsage { input, output, reasoning, cache_read, cache_write, cost, model_id, timestamp_ms }`
- `OpenCodeSession { id, watermark, project_path }`
- `parse_opencode_message_data(value: &serde_json::Value) -> Option<OpenCodeUsage>`
- `query_sessions(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<OpenCodeSession>>`
- `query_assistant_messages(conn, session_id) -> rusqlite::Result<(Vec<(String, OpenCodeUsage)>, bool)>`
- `insert_opencode_record(conn, request_id, usage, session_id, project_path, created_at) -> bool`
- `usage_records.provider = 'opencode'`
- TypeScript scope: `StatsScope = 'all' | 'claude' | 'codex' | 'opencode'`
- TypeScript terminal type: `TerminalType` includes `'opencode'`

### 3. Contracts
- OpenCode usage source is SQLite `opencode.db`, not jsonl session logs.
- DB path priority is `OPENCODE_DB` when non-empty, then `XDG_DATA_HOME/opencode/opencode.db` when non-empty, then `~/.local/share/opencode/opencode.db`.
- A relative `OPENCODE_DB` is resolved under the OpenCode data directory; an absolute value is used as-is.
- File-level modified time is `max(mtime(opencode.db), mtime(opencode.db-wal))` in nanoseconds.
- Session query returns `session.directory` as `OpenCodeSession.project_path` in addition to the watermark from `session.time_updated` and max `message.time_updated`.
- Every OpenCode row stores that raw session directory in `usage_records.project_path`; project aggregation and basename display must reuse the same path contract as Claude/Codex instead of emitting an empty bucket.
- Assistant message ingestion only counts `role == 'assistant'` rows with `tokens` and completed `time.completed`.
- Missing or null `time.completed` marks the session incomplete; completed messages may still insert, but the session watermark must not advance.
- OpenCode `time.created` is epoch milliseconds and must be stored in `usage_records.created_at` as epoch seconds.
- `reasoning` tokens are counted into output tokens: `output_tokens = output + reasoning`.
- When OpenCode message `cost > 0`, store it directly in `total_cost_usd` and leave component cost fields at zero. Only `cost == 0` falls back to the static pricing table.
- Any change that repairs already-persisted OpenCode attribution must bump `STATS_PARSER_VERSION`; otherwise `INSERT OR IGNORE` and session watermarks leave old empty `project_path` rows frozen.
- OpenCode is not a `ProviderSessionProvider` for the legacy Claude/Codex JSONL
  resume-discovery path (`provider_find_recent_session` / startup bulk scan).
- OpenCode Session Catalog is a separate on-demand capability via
  `provider_list_agent_sessions` + the OpenCode CLI list/export adapter.
  Do not reuse usage watermarks or SQLite ingestion as catalog state.
- Do not add OpenCode to the legacy Claude/Codex JSONL discovery union.

### 4. Validation & Error Matrix
- Missing `opencode.db` -> no-op sync result, no user-visible error.
- Read/open/query failure on existing `opencode.db` -> add sync error and do not advance the file-level watermark.
- Missing or incompatible `session.directory` schema -> treat as a session query failure and do not advance the file-level watermark.
- Session with incomplete usage -> do not advance that session watermark.
- Duplicate `request_id = opencode_session:{session_id}:{message_id}` -> `INSERT OR IGNORE` skips without double counting.
- Unknown model with `cost == 0` -> cost remains zero through pricing fallback.
- `scope = 'opencode'` -> aggregate only `usage_records.provider = 'opencode'`.
- `scope = 'all'` -> OpenCode rows are included with Claude and Codex rows.

### 5. Good/Base/Bad Cases
- Good: OpenCode writes one completed assistant message with cost; stats sync inserts one `opencode` row with direct total cost, output including reasoning, and `project_path = session.directory`.
- Base: No OpenCode installation exists; Claude/Codex stats and terminal behavior are unchanged.
- Base: A parser-version bump rebuilds historical OpenCode rows once, after which the existing mtime/session watermarks remain incremental.
- Bad: Reusing `insert_record()` for OpenCode, because it always applies static pricing and writes `data_source = 'session_log'`.
- Bad: Reading only `opencode.db` mtime and ignoring `opencode.db-wal`, because active WAL writes can be missed before checkpoint.
- Bad: Hard-coding an empty OpenCode `project_path`, because the stats panel then renders a nameless project bucket even though `session.directory` is available.
- Bad: Adding OpenCode to the legacy Claude/Codex JSONL resume-discovery path;
  OpenCode history for recovery uses the separate Session Catalog CLI adapter.
- Bad: Reusing OpenCode usage watermarks or `usage_records` as Session Catalog
  state; catalog browsing must stay non-persisted and independent of stats sync.

### 6. Tests Required
- Parser unit test for the OpenCode sample JSON, including `reasoning`, cache fields, cost, model id, and millisecond timestamp.
- Parser unit test that all-zero token usage returns `None`.
- SQLite query unit test for session watermark selection and `session.directory` propagation.
- SQLite query unit test that incomplete assistant messages are skipped and reported via `has_incomplete_usage`.
- Sync insert unit tests for direct OpenCode cost, static-pricing fallback, and persisted `project_path`.
- Aggregate unit test for `scope = 'opencode'`.
- Frontend tests or typecheck coverage for `TerminalType` / `terminalTypeMeta` exhaustiveness and OpenCode AI CLI badge behavior.

### 7. Wrong vs Correct

Wrong:
```rust
insert_record(&conn, request_id, "opencode", &record, "", created_at);
```

Correct:
```rust
insert_opencode_record(
    &conn,
    request_id,
    &usage,
    session_id,
    &session.project_path,
    created_at,
);
```

Wrong:
```rust
params![request_id, "opencode", usage.model_id, session_id, "", created_at]
```

Correct:
```rust
params![
    request_id,
    "opencode",
    usage.model_id,
    session_id,
    project_path,
    created_at,
]
```

Wrong:
```rust
let output_tokens = usage.output;
```

Correct:
```rust
let output_tokens = usage.output.saturating_add(usage.reasoning);
```

</spec-entry>
