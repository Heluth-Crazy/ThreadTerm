# Stats OpenCode Usage Ingestion

<spec-entry category="contract" keywords="stats,opencode,sqlite,usage_records,token-usage,terminal-type" date="2026-06-25" source="src-tauri/src/stats/opencode.rs:1">

## Scenario: OpenCode SQLite Usage Ingestion

### 1. Scope / Trigger
- Trigger: Any change to OpenCode token usage ingestion, stats provider scope handling, `usage_records` writes for OpenCode, or the `opencode` terminal type.
- Applies to `src-tauri/src/stats/opencode.rs`, `src-tauri/src/stats/sync.rs`, `src-tauri/src/stats/aggregate.rs`, `src/types/stats.ts`, `src/types/terminal.ts`, and terminal type metadata.

### 2. Signatures
- `opencode_db_path() -> PathBuf`
- `OpenCodeUsage { input, output, reasoning, cache_read, cache_write, cost, model_id, timestamp_ms }`
- `parse_opencode_message_data(value: &serde_json::Value) -> Option<OpenCodeUsage>`
- `query_sessions(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, i64)>>`
- `query_assistant_messages(conn, session_id) -> rusqlite::Result<(Vec<(String, OpenCodeUsage)>, bool)>`
- `usage_records.provider = 'opencode'`
- TypeScript scope: `StatsScope = 'all' | 'claude' | 'codex' | 'opencode'`
- TypeScript terminal type: `TerminalType` includes `'opencode'`

### 3. Contracts
- OpenCode usage source is SQLite `opencode.db`, not jsonl session logs.
- DB path priority is `OPENCODE_DB` when non-empty, then `XDG_DATA_HOME/opencode/opencode.db` when non-empty, then `~/.local/share/opencode/opencode.db`.
- A relative `OPENCODE_DB` is resolved under the OpenCode data directory; an absolute value is used as-is.
- File-level modified time is `max(mtime(opencode.db), mtime(opencode.db-wal))` in nanoseconds.
- Session watermark query uses `session.time_updated` and max `message.time_updated`.
- Assistant message ingestion only counts `role == 'assistant'` rows with `tokens` and completed `time.completed`.
- Missing or null `time.completed` marks the session incomplete; completed messages may still insert, but the session watermark must not advance.
- OpenCode `time.created` is epoch milliseconds and must be stored in `usage_records.created_at` as epoch seconds.
- `reasoning` tokens are counted into output tokens: `output_tokens = output + reasoning`.
- When OpenCode message `cost > 0`, store it directly in `total_cost_usd` and leave component cost fields at zero. Only `cost == 0` falls back to the static pricing table.
- OpenCode is not a `ProviderSessionProvider`; do not add it to Claude/Codex resume discovery.

### 4. Validation & Error Matrix
- Missing `opencode.db` -> no-op sync result, no user-visible error.
- Read/open/query failure on existing `opencode.db` -> add sync error and do not advance the file-level watermark.
- Session with incomplete usage -> do not advance that session watermark.
- Duplicate `request_id = opencode_session:{session_id}:{message_id}` -> `INSERT OR IGNORE` skips without double counting.
- Unknown model with `cost == 0` -> cost remains zero through pricing fallback.
- `scope = 'opencode'` -> aggregate only `usage_records.provider = 'opencode'`.
- `scope = 'all'` -> OpenCode rows are included with Claude and Codex rows.

### 5. Good/Base/Bad Cases
- Good: OpenCode writes one completed assistant message with cost; stats sync inserts one `opencode` row with direct total cost and output including reasoning.
- Base: No OpenCode installation exists; Claude/Codex stats and terminal behavior are unchanged.
- Bad: Reusing `insert_record()` for OpenCode, because it always applies static pricing and writes `data_source = 'session_log'`.
- Bad: Reading only `opencode.db` mtime and ignoring `opencode.db-wal`, because active WAL writes can be missed before checkpoint.
- Bad: Adding OpenCode to provider-session resume logic; OpenCode history lives in its own SQLite schema.

### 6. Tests Required
- Parser unit test for the OpenCode sample JSON, including `reasoning`, cache fields, cost, model id, and millisecond timestamp.
- Parser unit test that all-zero token usage returns `None`.
- SQLite query unit test for session watermark selection.
- SQLite query unit test that incomplete assistant messages are skipped and reported via `has_incomplete_usage`.
- Sync insert unit tests for direct OpenCode cost and static-pricing fallback.
- Aggregate unit test for `scope = 'opencode'`.
- Frontend tests or typecheck coverage for `TerminalType` / `terminalTypeMeta` exhaustiveness and OpenCode AI CLI badge behavior.

### 7. Wrong vs Correct

Wrong:
```rust
insert_record(&conn, request_id, "opencode", &record, "", created_at);
```

Correct:
```rust
insert_opencode_record(&conn, request_id, &usage, session_id, created_at);
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
